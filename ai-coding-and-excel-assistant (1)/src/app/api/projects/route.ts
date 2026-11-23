import { db, ensureSchema } from "@/db";
import { projects } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MAX_CODE = 200_000;

function text(value: unknown, max: number, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, max) : fallback;
}

/** Lists saved projects, most recently updated first (without the code bodies). */
export async function GET() {
  await ensureSchema();
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      prompt: projects.prompt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .orderBy(desc(projects.updatedAt))
    .limit(100);
  return Response.json({ projects: rows });
}

/** Creates a project from { name, prompt, html, css, js }. */
export async function POST(request: Request) {
  await ensureSchema();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const [row] = await db
    .insert(projects)
    .values({
      name: text(body.name, 120).trim() || "Untitled project",
      prompt: text(body.prompt, 4000),
      html: text(body.html, MAX_CODE),
      css: text(body.css, MAX_CODE),
      js: text(body.js, MAX_CODE),
    })
    .returning();

  return Response.json({ project: row }, { status: 201 });
}
