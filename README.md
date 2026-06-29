# Merkley Mayhem

A real-time party game web app. Four teams. Secret actions. Score swings.

## Setup

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a free project.

### 2. Run the schema

In the Supabase SQL editor, paste and run the contents of `supabase-schema.sql`.

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in your project credentials:

```
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

Find these in: Supabase Dashboard → Project Settings → API.

### 4. Install and run

```bash
npm install
npm run dev
```

### 5. Deploy to GitHub Pages

Add your `.env` values as repository secrets (`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`), then push. The included GitHub Actions workflow handles the rest.

## How to Play

1. **Host** goes to `/host` → creates a room → shares the room code.
2. **Teams** go to `/` → enter the room code → claim a slot on their device.
3. **Scoreboard** goes on a big screen at `/scoreboard/ROOMCODE`.
4. Host starts the game. Each round, teams choose Keep / Give / Steal and lock in.
5. Once all four teams lock in, the round auto-resolves and scores update.

## Game Rules

| Action | Effect |
|--------|--------|
| Keep   | +2 to you |
| Give   | +4 to shared pot, split evenly among all 4 teams |
| Steal  | +1 to you; pick 1 target (−2) or 2 targets (−1 each) |

Scores can go negative. Actions are hidden until the round resolves.

## Views

- `#/` — Join as a team
- `#/team/ROOMCODE` — Team play view (one device per team)
- `#/scoreboard/ROOMCODE` — Public scoreboard (put on a TV/projector)
- `#/host/ROOMCODE` — Host control panel
