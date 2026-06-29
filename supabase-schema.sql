-- Merkley Mayhem — Supabase Schema
-- Run this in your Supabase SQL editor

-- ============================================================
-- Tables
-- ============================================================

create table if not exists games (
  id             uuid primary key default gen_random_uuid(),
  room_code      text unique not null,
  status         text not null default 'waiting' check (status in ('waiting', 'active', 'ended')),
  current_round  int not null default 1,
  total_rounds   int not null default 5,
  resolved_round int not null default 0,
  created_at     timestamptz not null default now()
);

create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references games(id) on delete cascade,
  name       text not null default 'Team',
  device_id  text not null,
  score      int not null default 0,
  last_delta int not null default 0,
  slot       int not null check (slot between 1 and 4),
  created_at timestamptz not null default now(),
  unique (game_id, slot),
  unique (game_id, device_id)
);

create table if not exists submissions (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references games(id) on delete cascade,
  team_id      uuid not null references teams(id) on delete cascade,
  round_number int not null,
  action       text not null check (action in ('keep', 'give', 'steal')),
  targets      uuid[] not null default '{}',
  locked       boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (game_id, team_id, round_number)
);

-- ============================================================
-- Enable Realtime
-- ============================================================

alter publication supabase_realtime add table games;
alter publication supabase_realtime add table teams;
alter publication supabase_realtime add table submissions;

-- ============================================================
-- Row Level Security (permissive — party game)
-- ============================================================

alter table games       enable row level security;
alter table teams       enable row level security;
alter table submissions enable row level security;

create policy "games_all"       on games       for all using (true) with check (true);
create policy "teams_all"       on teams       for all using (true) with check (true);
create policy "submissions_all" on submissions for all using (true) with check (true);

-- ============================================================
-- RPC: create_game
-- Creates a new game and returns the room code
-- ============================================================

create or replace function create_game(p_total_rounds int default 5)
returns text
language plpgsql
security definer
as $$
declare
  v_room_code text;
begin
  loop
    v_room_code := upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 6));
    exit when not exists (select 1 from games where room_code = v_room_code);
  end loop;

  insert into games (room_code, status, total_rounds)
  values (v_room_code, 'waiting', p_total_rounds);

  return v_room_code;
end;
$$;

-- ============================================================
-- RPC: resolve_round
-- Atomically resolves the current round for a game.
-- Safe to call from multiple clients — idempotent.
-- ============================================================

create or replace function resolve_round(p_room_code text)
returns boolean
language plpgsql
security definer
as $$
declare
  v_game_id        uuid;
  v_current_round  int;
  v_resolved_round int;
  v_total_rounds   int;
  v_status         text;
  v_team_count     int;
  v_locked_count   int;
  v_give_pot       int := 0;
  v_give_share     int;
  v_sub            record;
begin
  -- Lock the game row to prevent concurrent resolution
  select id, current_round, resolved_round, total_rounds, status
    into v_game_id, v_current_round, v_resolved_round, v_total_rounds, v_status
  from games
  where room_code = p_room_code
  for update;

  if not found then
    return false;
  end if;

  -- Already resolved or game not active
  if v_resolved_round >= v_current_round or v_status != 'active' then
    return false;
  end if;

  -- Count actual teams in this game (supports 1–4 players)
  select count(*) into v_team_count from teams where game_id = v_game_id;
  if v_team_count = 0 then return false; end if;

  -- Verify all teams have locked submissions for this round
  select count(*) into v_locked_count
  from submissions s
  join teams t on t.id = s.team_id
  where t.game_id = v_game_id
    and s.round_number = v_current_round
    and s.locked = true;

  if v_locked_count < v_team_count then
    return false;
  end if;

  -- Mark round as resolved immediately (blocks concurrent calls)
  update games set resolved_round = v_current_round where id = v_game_id;

  -- Reset all last_delta values
  update teams set last_delta = 0 where game_id = v_game_id;

  -- Calculate Give pot (each Give contributes +4)
  select count(*) * 4 into v_give_pot
  from submissions s
  join teams t on t.id = s.team_id
  where t.game_id = v_game_id
    and s.round_number = v_current_round
    and s.action = 'give';

  -- Distribute Give pot evenly to all teams
  if v_give_pot > 0 then
    v_give_share := v_give_pot / v_team_count;
    update teams
    set score      = score + v_give_share,
        last_delta = last_delta + v_give_share
    where game_id = v_game_id;
  end if;

  -- Apply Keep bonuses (+2 to the acting team)
  for v_sub in
    select s.team_id
    from submissions s
    join teams t on t.id = s.team_id
    where t.game_id = v_game_id
      and s.round_number = v_current_round
      and s.action = 'keep'
  loop
    update teams
    set score      = score + 2,
        last_delta = last_delta + 2
    where id = v_sub.team_id;
  end loop;

  -- Apply Steal: acting team +1, targets lose points
  for v_sub in
    select s.team_id, s.targets
    from submissions s
    join teams t on t.id = s.team_id
    where t.game_id = v_game_id
      and s.round_number = v_current_round
      and s.action = 'steal'
  loop
    -- Stealer gains +1
    update teams
    set score      = score + 1,
        last_delta = last_delta + 1
    where id = v_sub.team_id;

    if array_length(v_sub.targets, 1) = 1 then
      -- Single target loses -2
      update teams
      set score      = score - 2,
          last_delta = last_delta - 2
      where id = v_sub.targets[1];
    elsif array_length(v_sub.targets, 1) = 2 then
      -- Two targets each lose -1
      update teams
      set score      = score - 1,
          last_delta = last_delta - 1
      where id = v_sub.targets[1];
      update teams
      set score      = score - 1,
          last_delta = last_delta - 1
      where id = v_sub.targets[2];
    end if;
  end loop;

  -- Advance round or end game
  if v_current_round >= v_total_rounds then
    update games set status = 'ended' where id = v_game_id;
  else
    update games set current_round = v_current_round + 1 where id = v_game_id;
  end if;

  return true;
end;
$$;

-- ============================================================
-- Grants (allow anonymous clients to call RPCs)
-- ============================================================

grant execute on function create_game(int)    to anon, authenticated;
grant execute on function resolve_round(text) to anon, authenticated;
