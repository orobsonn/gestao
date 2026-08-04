/**
 * @description Seed e2e users + Casa Alpha domain sample (expert/campanha/tarefas)
 * via live local API (same D1 as Vite Cloudflare plugin).
 * Requires `npm run dev` already up and SUPER_ADMIN_* in .dev.vars.
 *
 * Password for all e2e users: password-e2e-ok
 * - admin@e2e.local  — admin Casa Alpha only
 * - membro@e2e.local — membro Casa Alpha only
 * - multi@e2e.local  — admin Casa Alpha + membro Casa Beta
 *
 * Home dashboard sample (idempotent by stable names):
 * - Expert E2E Alpha / Campanha E2E Alpha
 * - late + today tasks owned by admin; open/future by membro; one feito recent
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const PASSWORD = "password-e2e-ok";

const EXPERT_NOME = "Expert E2E Alpha";
const CAMPANHA_NOME = "Campanha E2E Alpha";

/** @description Stable tarefa titles used for idempotent re-seed. */
const TAREFA_TITLES = {
  lateAdmin: "E2E Atrasada Admin",
  todayAdmin: "E2E Vence Hoje Admin",
  futureMembro: "E2E Futura Membro",
  openMembro: "E2E Aberta Membro",
  feitoRecent: "E2E Feita Recente",
};

/**
 * @description Parse KEY=value from .dev.vars (no export).
 * @param {string} key
 */
function readDevVar(key) {
  const raw = readFileSync(resolve(process.cwd(), ".dev.vars"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    if (t.slice(0, i) === key) return t.slice(i + 1).trim();
  }
  return "";
}

/**
 * @param {string} path
 * @param {RequestInit & { cookie?: string }} [init]
 */
async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (init.cookie) headers.set("Cookie", init.cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookieHeader =
    setCookie
      .map((c) => c.split(";")[0])
      .filter(Boolean)
      .join("; ") || init.cookie;
  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { res, json, cookie: cookieHeader ?? "" };
}

/**
 * @param {string} email
 * @param {string} password
 */
async function login(email, password) {
  const { res, json, cookie } = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return { cookie, body: json };
}

/**
 * @param {string} cookie
 * @param {{ nome: string, adminEmail: string, adminName: string, adminPassword: string }} opts
 */
async function createEmpresa(cookie, opts) {
  const { res, json } = await api("/api/platform/empresas", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      nome: opts.nome,
      admin: {
        name: opts.adminName,
        email: opts.adminEmail,
        password: opts.adminPassword,
      },
    }),
  });
  // 201 created; 409 if already exists from prior run — treat as ok for idempotency
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `create empresa ${opts.nome}: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

/**
 * @param {string} cookie
 * @param {{ email: string, name: string, password: string, papel: string }} opts
 */
async function inviteMembro(cookie, opts) {
  const { res, json } = await api("/api/empresa/membros", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      email: opts.email,
      name: opts.name,
      password: opts.password,
      papel: opts.papel,
    }),
  });
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `invite ${opts.email}: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

/**
 * @description Calendar date YYYY-MM-DD in UTC (matches SQLite date('now')).
 * @param {number} offsetDays
 */
function ymdUtc(offsetDays = 0) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {string} cookie
 */
async function getMe(cookie) {
  const { res, json } = await api("/api/auth/me", { cookie });
  if (!res.ok) {
    throw new Error(`GET /api/auth/me: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * @param {string} cookie
 * @returns {Promise<Array<{ user_id: string, email: string, name: string, papel: string }>>}
 */
async function listMembros(cookie) {
  const { res, json } = await api("/api/empresa/membros", { cookie });
  if (!res.ok) {
    throw new Error(
      `GET /api/empresa/membros: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json?.membros ?? [];
}

/**
 * @description Ensure expert exists by nome; create if missing.
 * @param {string} cookie
 * @param {string} nome
 */
async function ensureExpert(cookie, nome) {
  const listed = await api("/api/empresa/experts", { cookie });
  if (!listed.res.ok) {
    throw new Error(
      `GET /api/empresa/experts: ${listed.res.status} ${JSON.stringify(listed.json)}`,
    );
  }
  const existing = (listed.json?.experts ?? []).find((e) => e.nome === nome);
  if (existing?.id) return existing;

  const { res, json } = await api("/api/empresa/experts", {
    method: "POST",
    cookie,
    body: JSON.stringify({ nome }),
  });
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `POST /api/empresa/experts: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  if (res.status === 201 && json?.id) return json;

  // 409 or missing body — re-list
  const again = await api("/api/empresa/experts", { cookie });
  const found = (again.json?.experts ?? []).find((e) => e.nome === nome);
  if (!found?.id) {
    throw new Error(`expert ${nome} not found after create`);
  }
  return found;
}

/**
 * @description Ensure campanha under expert by nome; create if missing.
 * @param {string} cookie
 * @param {string} expertId
 * @param {string} nome
 */
async function ensureCampanha(cookie, expertId, nome) {
  const listed = await api(`/api/empresa/experts/${expertId}/campanhas`, {
    cookie,
  });
  if (!listed.res.ok) {
    throw new Error(
      `GET campanhas: ${listed.res.status} ${JSON.stringify(listed.json)}`,
    );
  }
  const existing = (listed.json?.campanhas ?? []).find((c) => c.nome === nome);
  if (existing?.id) return existing;

  const { res, json } = await api("/api/empresa/campanhas", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      expert_id: expertId,
      nome,
      tipo: "perpetuo",
      status: "aberta",
    }),
  });
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `POST /api/empresa/campanhas: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  if (res.status === 201 && json?.id) return json;

  const again = await api(`/api/empresa/experts/${expertId}/campanhas`, {
    cookie,
  });
  const found = (again.json?.campanhas ?? []).find((c) => c.nome === nome);
  if (!found?.id) {
    throw new Error(`campanha ${nome} not found after create`);
  }
  return found;
}

/**
 * @description PATCH tarefa fields that drift across re-seeds (prazo/dono/status).
 * @param {string} cookie
 * @param {string} id
 * @param {{ prazo?: string | null, dono_id?: string, status?: string }} patch
 */
async function patchTarefa(cookie, id, patch) {
  const { res, json } = await api(`/api/empresa/tarefas/${id}`, {
    method: "PATCH",
    cookie,
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(
      `PATCH /api/empresa/tarefas/${id}: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

/**
 * @description Ensure tarefa by titulo under campanha; create if missing.
 * Re-syncs prazo/dono/status on existing rows so late/today stay correct across days.
 * @param {string} cookie
 * @param {string} campanhaId
 * @param {{ titulo: string, prazo?: string | null, dono_id?: string, status?: string, notas?: string }} opts
 */
async function ensureTarefa(cookie, campanhaId, opts) {
  const listed = await api(`/api/empresa/campanhas/${campanhaId}/tarefas`, {
    cookie,
  });
  if (!listed.res.ok) {
    throw new Error(
      `GET tarefas: ${listed.res.status} ${JSON.stringify(listed.json)}`,
    );
  }
  const existing = (listed.json?.tarefas ?? []).find(
    (t) => t.titulo === opts.titulo,
  );

  if (existing?.id) {
    /** @type {{ prazo?: string | null, dono_id?: string, status?: string }} */
    const patch = {};
    const wantPrazo = opts.prazo === undefined ? undefined : (opts.prazo ?? null);
    if (wantPrazo !== undefined && existing.prazo !== wantPrazo) {
      patch.prazo = wantPrazo;
    }
    if (opts.dono_id != null && existing.dono_id !== opts.dono_id) {
      patch.dono_id = opts.dono_id;
    }
    if (opts.status != null && existing.status !== opts.status) {
      patch.status = opts.status;
    }
    // feito seed: bump updated_at via status re-apply so feitas_7d stays fresh
    if (opts.status === "feito" && existing.status === "feito") {
      // force status write path (updated_at) by toggling a_fazer → feito
      await patchTarefa(cookie, existing.id, { status: "a_fazer" });
      return patchTarefa(cookie, existing.id, {
        ...patch,
        status: "feito",
        ...(wantPrazo !== undefined ? { prazo: wantPrazo } : {}),
        ...(opts.dono_id != null ? { dono_id: opts.dono_id } : {}),
      });
    }
    if (Object.keys(patch).length > 0) {
      return patchTarefa(cookie, existing.id, patch);
    }
    return existing;
  }

  /** @type {Record<string, unknown>} */
  const body = {
    campanha_id: campanhaId,
    titulo: opts.titulo,
  };
  if (opts.prazo != null) body.prazo = opts.prazo;
  if (opts.dono_id != null) body.dono_id = opts.dono_id;
  if (opts.status != null) body.status = opts.status;
  if (opts.notas != null) body.notas = opts.notas;

  const { res, json } = await api("/api/empresa/tarefas", {
    method: "POST",
    cookie,
    body: JSON.stringify(body),
  });
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(
      `POST /api/empresa/tarefas ${opts.titulo}: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  if (res.status === 201 && json?.id) return json;

  const again = await api(`/api/empresa/campanhas/${campanhaId}/tarefas`, {
    cookie,
  });
  const found = (again.json?.tarefas ?? []).find(
    (t) => t.titulo === opts.titulo,
  );
  if (!found?.id) {
    throw new Error(`tarefa ${opts.titulo} not found after create`);
  }
  return found;
}

/**
 * @description Seed expert/campanha/tarefas on Casa Alpha for home e2e.
 * @param {string} adminCookie
 */
async function seedCasaAlphaHomeSample(adminCookie) {
  const membros = await listMembros(adminCookie);
  const adminMember = membros.find((m) => m.email === "admin@e2e.local");
  const membroMember = membros.find((m) => m.email === "membro@e2e.local");
  if (!adminMember?.user_id) {
    throw new Error("admin@e2e.local not in Casa Alpha membros");
  }
  if (!membroMember?.user_id) {
    throw new Error("membro@e2e.local not in Casa Alpha membros");
  }

  const expert = await ensureExpert(adminCookie, EXPERT_NOME);
  const campanha = await ensureCampanha(adminCookie, expert.id, CAMPANHA_NOME);

  const yesterday = ymdUtc(-1);
  const today = ymdUtc(0);
  const nextWeek = ymdUtc(7);

  const created = await Promise.all([
    ensureTarefa(adminCookie, campanha.id, {
      titulo: TAREFA_TITLES.lateAdmin,
      prazo: yesterday,
      dono_id: adminMember.user_id,
      status: "a_fazer",
      notas: "e2e seed — atrasada admin",
    }),
    ensureTarefa(adminCookie, campanha.id, {
      titulo: TAREFA_TITLES.todayAdmin,
      prazo: today,
      dono_id: adminMember.user_id,
      status: "fazendo",
      notas: "e2e seed — vence hoje admin",
    }),
    ensureTarefa(adminCookie, campanha.id, {
      titulo: TAREFA_TITLES.futureMembro,
      prazo: nextWeek,
      dono_id: membroMember.user_id,
      status: "a_fazer",
      notas: "e2e seed — futura membro",
    }),
    ensureTarefa(adminCookie, campanha.id, {
      titulo: TAREFA_TITLES.openMembro,
      prazo: null,
      dono_id: membroMember.user_id,
      status: "a_fazer",
      notas: "e2e seed — aberta membro (sem prazo)",
    }),
    ensureTarefa(adminCookie, campanha.id, {
      titulo: TAREFA_TITLES.feitoRecent,
      dono_id: adminMember.user_id,
      status: "feito",
      notas: "e2e seed — feita recente",
    }),
  ]);

  return {
    expertId: expert.id,
    campanhaId: campanha.id,
    tarefaIds: created.map((t) => t.id),
    titulos: created.map((t) => t.titulo),
  };
}

async function main() {
  const saEmail = readDevVar("SUPER_ADMIN_EMAIL");
  const saPassword = readDevVar("SUPER_ADMIN_PASSWORD");
  if (!saEmail || !saPassword) {
    throw new Error("SUPER_ADMIN_EMAIL/PASSWORD missing in .dev.vars");
  }

  // Warm bootstrap (creates SA if needed)
  await api("/api/auth/me");

  const sa = await login(saEmail, saPassword);

  await createEmpresa(sa.cookie, {
    nome: "Casa Alpha",
    adminEmail: "admin@e2e.local",
    adminName: "Admin E2E",
    adminPassword: PASSWORD,
  });

  await createEmpresa(sa.cookie, {
    nome: "Casa Beta",
    adminEmail: "beta-admin@e2e.local",
    adminName: "Beta Admin E2E",
    adminPassword: PASSWORD,
  });

  // Alpha admin invites membro + multi as admin
  const alphaAdmin = await login("admin@e2e.local", PASSWORD);
  await inviteMembro(alphaAdmin.cookie, {
    email: "membro@e2e.local",
    name: "Membro E2E",
    password: PASSWORD,
    papel: "membro",
  });
  await inviteMembro(alphaAdmin.cookie, {
    email: "multi@e2e.local",
    name: "Multi E2E",
    password: PASSWORD,
    papel: "admin",
  });

  // Beta admin invites multi as membro (second house)
  const betaAdmin = await login("beta-admin@e2e.local", PASSWORD);
  await inviteMembro(betaAdmin.cookie, {
    email: "multi@e2e.local",
    name: "Multi E2E",
    password: PASSWORD,
    papel: "membro",
  });

  // Verify multi has 2 memberships and null or set active
  const multi = await login("multi@e2e.local", PASSWORD);
  const memberships = multi.body?.memberships ?? [];
  if (memberships.length < 2) {
    throw new Error(
      `multi expected ≥2 memberships, got ${JSON.stringify(multi.body)}`,
    );
  }

  // Home dashboard sample data on Casa Alpha (admin session already active)
  const homeSample = await seedCasaAlphaHomeSample(alphaAdmin.cookie);

  // Sanity: admin me still on Casa Alpha
  const adminMe = await getMe(alphaAdmin.cookie);
  if (!adminMe?.id) {
    throw new Error(`admin me missing id: ${JSON.stringify(adminMe)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        base: BASE,
        password: PASSWORD,
        users: {
          admin: "admin@e2e.local",
          membro: "membro@e2e.local",
          multi: "multi@e2e.local",
        },
        multiMemberships: memberships.map((m) => ({
          nome: m.nome,
          papel: m.papel,
        })),
        homeSample: {
          expert: EXPERT_NOME,
          campanha: CAMPANHA_NOME,
          tarefas: homeSample.titulos,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
