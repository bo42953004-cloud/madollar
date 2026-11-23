import { db, ensureSchema } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MAX_CODE = 200_000;

type Context = { params: Promise<{ id: string }> };

async function readId(context: Context): Promise<number | null> {
  const { id } = await context.params;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

export async function GET(_request: Request, context: Context) {
  await ensureSchema();
  const id = await readId(context);
  if (!id) return Response.json({ error: "Invalid id." }, { status: 400 });

  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!row) return Response.json({ error: "Project not found." }, { status: 404 });
  return Response.json({ project: row });
}

/** Saves code and metadata for an existing project. */
export async function PUT(request: Request, context: Context) {
  await ensureSchema();
  const id = await readId(context);
  if (!id) return Response.json({ error: "Invalid id." }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  const name = text(body.name, 120);
  if (name !== undefined) patch.name = name.trim() || "Untitled project";
  const prompt = text(body.prompt, 4000);
  if (prompt !== undefined) patch.prompt = prompt;
  const html = text(body.html, MAX_CODE);
  if (html !== undefined) patch.html = html;
  const css = text(body.css, MAX_CODE);
  if (css !== undefined) patch.css = css;
  const js = text(body.js, MAX_CODE);
  if (js !== undefined) patch.js = js;

  const [row] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
  if (!row) return Response.json({ error: "Project not found." }, { status: 404 });
  return Response.json({ project: row });
}

export async function DELETE(_request: Request, context: Context) {
  await ensureSchema();
  const id = await readId(context);
  if (!id) return Response.json({ error: "Invalid id." }, { status: 400 });

  await db.delete(projects).where(eq(projects.id, id));
  return Response.json({ ok: true });
}
