import { serve } from "bun";
import index from "./index.html";
import { existsSync } from "fs";
import path from "path";

const WAITLIST_FILE = path.join(import.meta.dir, "../waitlist.json");

async function loadWaitlist(): Promise<string[]> {
  if (existsSync(WAITLIST_FILE)) {
    return JSON.parse(await Bun.file(WAITLIST_FILE).text());
  }
  return [];
}

async function saveWaitlist(emails: string[]) {
  await Bun.write(WAITLIST_FILE, JSON.stringify(emails, null, 2));
}

const server = serve({
  routes: {
    "/api/waitlist": {
      async POST(req) {
        try {
          const { email } = await req.json();
          if (!email || typeof email !== "string" || !email.includes("@")) {
            return Response.json({ error: "Invalid email" }, { status: 400 });
          }

          const emails = await loadWaitlist();
          if (emails.includes(email.toLowerCase().trim())) {
            return Response.json({ message: "Already registered" });
          }

          emails.push(email.toLowerCase().trim());
          await saveWaitlist(emails);

          console.log(`[waitlist] +1 → ${emails.length} total: ${email}`);
          return Response.json({ message: "Added to waitlist" });
        } catch {
          return Response.json({ error: "Server error" }, { status: 500 });
        }
      },
      async GET() {
        const emails = await loadWaitlist();
        return Response.json({ count: emails.length });
      },
    },

    // Serve index.html for all unmatched routes
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`\n  CATE website → ${server.url}\n`);
