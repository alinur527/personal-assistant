// Local-only PostgreSQL verification. No env files or hosted DB connections.
// Auth/storage contracts below stand in for Supabase-managed schemas.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const container = `lifeos-assistant-test-${randomUUID().slice(0, 8)}`;
function docker(args, input) {
  const result = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr ||
        result.stdout ||
        result.error?.message ||
        "Docker failed",
    );
  return result.stdout;
}
const sql = (input, database = "postgres") =>
  docker(
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
    ],
    input,
  );
const bootstrap = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select current_user::text $$;
grant usage on schema auth to authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1, '/') $$;
`;
const dir = join(root, "supabase", "migrations");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const migration = "20260929000200_assistant_foundation.sql";
const baseline = files.filter((name) => name < migration);
let started = false;
try {
  docker([
    "run",
    "--rm",
    "--detach",
    "--name",
    container,
    "--network",
    "none",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:17.6-bookworm",
  ]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = spawnSync(
      "docker",
      ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
      { encoding: "utf8" },
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("Local PostgreSQL did not become ready");
  sql(
    "create role anon; create role authenticated; create role service_role bypassrls; create database clean; create database upgrade;",
  );
  for (const database of ["clean", "upgrade"]) {
    sql(bootstrap, database);
    for (const file of baseline) {
      try {
        sql(readFileSync(join(dir, file), "utf8"), database);
      } catch (error) {
        throw new Error(
          `${database}: baseline migration ${file}: ${error.message}`,
        );
      }
    }
    if (database === "upgrade")
      sql(
        `
      insert into auth.users(id) values ('00000000-0000-0000-0000-000000000099');
      insert into public.tasks(user_id, title) values ('00000000-0000-0000-0000-000000000099', 'upgrade sentinel');
    `,
        database,
      );
    sql(readFileSync(join(dir, migration), "utf8"), database);
    sql(
      readFileSync(
        join(root, "supabase", "tests", "assistant_foundation.sql"),
        "utf8",
      ),
      database,
    );
    if (database === "upgrade")
      sql(
        `do $$ begin
      if not exists (select from public.tasks where title = 'upgrade sentinel' and user_id = '00000000-0000-0000-0000-000000000099') then raise exception 'upgrade lost existing data'; end if;
    end $$;`,
        database,
      );
    console.log(
      `${database}: ${baseline.length + 1} migrations; memory lifecycle, RLS, grants, audit dedupe verified`,
    );
  }
} finally {
  if (started) docker(["stop", container]);
}
