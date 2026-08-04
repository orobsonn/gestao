/** @description Minimal /platform page: super_admin create-empresa form or denied. */

import { useEffect, useState, type FormEvent } from "react";
import { canShowPlatformCreate } from "../lib/platform-access";

type MeUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

type PageState =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "ready" }
  | { status: "error"; message: string };

/**
 * @description Fetches /api/auth/me; shows denied or create-empresa form for super_admin.
 */
export function PlatformPage() {
  const [page, setPage] = useState<PageState>({ status: "loading" });
  const [nome, setNome] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });
        if (!res.ok) {
          if (!cancelled) setPage({ status: "denied" });
          return;
        }
        const me = (await res.json()) as MeUser;
        if (!cancelled) {
          setPage(
            canShowPlatformCreate(me.role)
              ? { status: "ready" }
              : { status: "denied" },
          );
        }
      } catch {
        if (!cancelled) {
          setPage({ status: "error", message: "Falha ao carregar sessão." });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitMsg(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/platform/empresas", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome,
          admin: {
            name: adminName,
            email: adminEmail,
            password: adminPassword,
          },
        }),
      });
      if (res.status === 201) {
        setSubmitMsg("Empresa criada.");
        setNome("");
        setAdminName("");
        setAdminEmail("");
        setAdminPassword("");
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setSubmitMsg(body?.error ?? `Erro ${res.status}`);
    } catch {
      setSubmitMsg("Falha de rede.");
    } finally {
      setSubmitting(false);
    }
  }

  if (page.status === "loading") {
    return (
      <main className="page">
        <p>Carregando…</p>
      </main>
    );
  }

  if (page.status === "error") {
    return (
      <main className="page">
        <p className="msg-error">{page.message}</p>
      </main>
    );
  }

  if (page.status === "denied") {
    return (
      <main className="page">
        <h1>Acesso negado</h1>
        <p>Somente super_admin pode criar empresas na plataforma.</p>
      </main>
    );
  }

  return (
    <main className="page">
      <h1>Nova empresa</h1>
      <form className="form" onSubmit={onSubmit}>
        <label>
          Nome da empresa
          <input
            name="nome"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            required
            autoComplete="organization"
          />
        </label>
        <label>
          Nome do admin
          <input
            name="admin.name"
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
            required
            autoComplete="name"
          />
        </label>
        <label>
          Email do admin
          <input
            name="admin.email"
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          Senha do admin
          <input
            name="admin.password"
            type="password"
            value={adminPassword}
            onChange={(e) => setAdminPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? "Criando…" : "Criar empresa"}
        </button>
      </form>
      {submitMsg ? <p className="msg">{submitMsg}</p> : null}
    </main>
  );
}
