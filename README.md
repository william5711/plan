# Plan

A phone-first day planner. It has three parts:

- **Today:** an hour-by-hour timeline with a "now" line, plus what's happening now and next.
- **Upcoming:** the next 7 days, with busy days flagged, plus a Someday list.
- **Claude:** chat with Claude in the Claude app and it updates your schedule through a connector. Every change it makes appears here with an Undo button.

You can still add, edit, move and complete everything by hand: use the **+** button, or tap an empty spot on the timeline.

Plan works the same way as Pocket. It's a single static page (`index.html`) hosted on GitHub Pages, with data stored in Supabase. It uses **the same Supabase project and the same sign-in as Pocket**, but keeps its data in its own `plan_*` tables.

## Setup

### 1. Database
In Supabase → **SQL Editor**, paste [`setup.sql`](setup.sql) and run it. It's safe to run again.

### 2. Host the app
1. Create a new GitHub repository (for example `plan`) and push this folder to it.
2. In the repository's **Settings → Pages**, publish the `main` branch from the root.
3. In Supabase → **Authentication → URL Configuration**, add the Plan address (for example `https://<you>.github.io/plan/`) under **Redirect URLs**. Keep Pocket's Site URL as it is. This lets password-reset links bring you back to Plan.

### 3. Install on iPhone
Open the GitHub Pages address in **Safari**, then tap **Share → Add to Home Screen**. Open Plan from the new icon and sign in with your Pocket account.

### 4. Deploy the Claude connector
The connector is the Edge Function in [`supabase/functions/plan-mcp/index.ts`](supabase/functions/plan-mcp/index.ts).

**From the Supabase dashboard (no tools needed):**
1. Go to **Edge Functions → Deploy a new function → Via editor**.
2. Name it exactly `plan-mcp`, replace the sample code with the contents of `index.ts`, and deploy.
3. Open the function's **Details** and turn **off** "Verify JWT with legacy secret" (or "Enforce JWT verification"). The connector checks its own secret link instead. With JWT verification on, the Claude app gets a 401 error.

**Or with the Supabase CLI:**
```bash
supabase functions deploy plan-mcp --no-verify-jwt --project-ref yjzlpgiklxrnimqzdbjt
```

### 5. Connect the Claude app
1. In Plan, open the **Claude** tab → **Create connector link** → **Copy link**. The link is shown only once.
2. On claude.ai (on a computer), go to **Settings → Connectors → Add custom connector**. Name it `Plan`, paste the link, and under **Authentication** choose **No sign-in** (the link itself is the key). Choosing a sign-in option gives a "Couldn't register with plan's sign-in service" error.
3. In any chat, on claude.ai or in the Claude phone app, make sure Plan is turned on in the chat's tools menu. Then just talk:
   - "I have a STATS midterm Thursday at 9am. Plan study sessions this week around my classes."
   - "I'm wiped, move everything flexible after 8pm to tomorrow."
   - "Done with the problem set. What's next today?"
   - "My classes are Mon/Wed 10–11:15 and I focus best in the morning. Remember that."

## Security

- The connector link works like a password. Anyone who has it can read and change your schedule. Don't share it or paste it anywhere public.
- Only a SHA-256 hash of the link's secret is stored in the database.
- To cut off access, tap **Turn off** in the Claude tab. To replace the link, tap **Make a new link**; the old one stops working right away.
- The Edge Function uses the service-role key, which Supabase provides to the function automatically and never sends to the browser. Every query it runs is limited to the account the link belongs to.

## What Claude can do

| Tool | What it does |
|---|---|
| `get_schedule` | Reads today's date and time in your time zone, your preferences, the next days' blocks, left-over tasks and Someday |
| `add_tasks` | Adds blocks or tasks (up to 25 at once) and warns about overlaps |
| `update_tasks` | Moves, edits or completes tasks |
| `delete_tasks` | Removes tasks (only when you ask) |
| `set_preferences` | Saves your day start/end, focus hours, standing notes and time zone |

**Fixed** blocks (classes, shifts, exams) are never moved unless you ask. **Flexible** blocks can be rearranged.

## Trying it without signing in
Open the page with `?preview` at the end of the address (for example `index.html?preview`) to see it with sample data. Nothing is saved in preview mode.

## Troubleshooting
- **"Run setup.sql in Supabase first"** means the tables don't exist yet. Do step 1.
- **The Claude app says the connector failed or isn't authorized:** check that the function is named `plan-mcp`, that JWT verification is off, and that you copied the whole link. Then make a new link and add it again.
- **The function logs show an error about the service role key:** in Edge Functions → Secrets, check that `SUPABASE_SERVICE_ROLE_KEY` is listed. Supabase normally adds it automatically.
