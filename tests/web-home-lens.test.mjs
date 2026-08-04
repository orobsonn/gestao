/**
 * Locked home-lens visibility matrix (pure helpers).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveHomeLens } from "../src/react-app/lib/home-lens.ts";

/**
 * @description Map KPI bindings to label → field for matrix assertions.
 * @param {Array<{ label: string, field: string }>} kpis
 * @returns {Record<string, string>}
 */
function kpiMap(kpis) {
  assert.ok(Array.isArray(kpis), "kpis must be an array of { label, field }");
  /** @type {Record<string, string>} */
  const map = {};
  for (const item of kpis) {
    assert.equal(typeof item.label, "string");
    assert.equal(typeof item.field, "string");
    map[item.label] = item.field;
  }
  return map;
}

/**
 * @description Admin lens 'tudo' shows both lists, charts, and empresa+minhas KPI bindings.
 */
test("lt-lens-tudo-matrix", () => {
  const result = resolveHomeLens({ papel: "admin", lens: "tudo" });

  assert.equal(result.showMeuTrabalho, true);
  assert.equal(result.showEmpresaAbertas, true);
  assert.equal(result.showCharts, true);

  const kpis = kpiMap(result.kpis);
  assert.equal(kpis["Atrasadas"], "atrasadas_empresa");
  assert.equal(kpis["Hoje"], "vencem_hoje_empresa");
  assert.equal(kpis["Minhas"], "minhas_abertas");
  assert.equal(kpis["Feitas 7d"], "feitas_7d_empresa");
});

/**
 * @description Admin lens 'so_meu' shows only meu trabalho, hides charts, and binds personal KPIs.
 */
test("lt-lens-so-meu-matrix", () => {
  const result = resolveHomeLens({ papel: "admin", lens: "so_meu" });

  assert.equal(result.showMeuTrabalho, true);
  assert.equal(result.showEmpresaAbertas, false);
  assert.equal(result.showCharts, false);

  const kpis = kpiMap(result.kpis);
  assert.equal(kpis["Atrasadas"], "minhas_atrasadas");
  assert.equal(kpis["Hoje"], "minhas_vencem_hoje");
  assert.equal(kpis["Minhas"], "minhas_abertas");
  assert.equal(kpis["Feitas 7d"], "minhas_feitas_7d");
});

/**
 * @description Admin lens 'so_empresa' hides meu trabalho, shows empresa list+charts, and binds empresa KPIs.
 */
test("lt-lens-so-empresa-matrix", () => {
  const result = resolveHomeLens({ papel: "admin", lens: "so_empresa" });

  assert.equal(result.showMeuTrabalho, false);
  assert.equal(result.showEmpresaAbertas, true);
  assert.equal(result.showCharts, true);

  const kpis = kpiMap(result.kpis);
  assert.equal(kpis["Atrasadas"], "atrasadas_empresa");
  assert.equal(kpis["Hoje"], "vencem_hoje_empresa");
  assert.equal(kpis["Abertas"], "abertas_empresa");
  assert.equal(kpis["Feitas 7d"], "feitas_7d_empresa");
});

/**
 * @description Membro has no toggle, personal-only lists/KPIs, never empresa list or expert breakdown.
 */
test("lt-lens-membro-no-empresa-no-toggle", () => {
  // Lens arg ignored or forced — personal-only regardless of requested lens.
  for (const lens of ["tudo", "so_meu", "so_empresa", undefined]) {
    const result = resolveHomeLens(
      lens === undefined
        ? { papel: "membro" }
        : { papel: "membro", lens },
    );

    assert.equal(
      result.showToggle,
      false,
      `membro showToggle must be false (lens=${String(lens)})`,
    );
    assert.equal(result.showMeuTrabalho, true);
    assert.equal(result.showEmpresaAbertas, false);
    assert.equal(
      result.showAtrasadasPorExpert,
      false,
      "membro must never show atrasadas_por_expert",
    );

    const kpis = kpiMap(result.kpis);
    assert.equal(kpis["Atrasadas"], "minhas_atrasadas");
    assert.equal(kpis["Hoje"], "minhas_vencem_hoje");
    assert.equal(kpis["Minhas"], "minhas_abertas");
    assert.equal(kpis["Feitas 7d"], "minhas_feitas_7d");

    // showCharts may be true only for personal urgencia/status (never expert breakdown).
    if (result.showCharts === true) {
      assert.equal(
        result.showAtrasadasPorExpert,
        false,
        "personal charts must not include expert breakdown",
      );
    }
  }
});
