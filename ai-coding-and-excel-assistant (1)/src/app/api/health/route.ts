import { db, ensureSchema } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Reports whether the app and its database are ready. */
export async function GET() {
  if (!process.env.DATABASE_URL) {
    return Response.json(
      { ok: false, database: "missing", message: "DATABASE_URL is not set." },
      { status: 500 },
    );
  }
  try {
    await ensureSchema();
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, database: "connected" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown database error";
    return Response.json({ ok: false, database: "error", message }, { status: 500 });
  }
}
