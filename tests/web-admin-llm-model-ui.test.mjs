/**
 * Locked Admin LLM model-selection contract — the pure decision surface behind #uj-1:
 * which value is sent, when the save is available, and what the operator is told.
 * Hermetic: pure module imports only. Nothing is rendered and no source text is asserted.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canSaveLlmModel,
  LLM_MODEL_DEFAULT_LABEL,
  LLM_MODEL_DEFAULT_OPTION,
  llmModelHelpCopy,
  llmRetiredModelCopy,
  llmModelSelectValue,
  mapLlmModelSaveFeedback,
  resolveLlmModelSelection,
  shouldApplyLlmWrite,
} from "../src/react-app/lib/admin-ui.ts";

/** @description Base state where saving IS allowed; each case perturbs exactly one field. */
const SAVEABLE = {
  saving: false,
  savingModel: false,
  validating: false,
  savedProvider: "openai",
  selectedProvider: "openai",
  modelSelection: "gpt-5.6-terra",
  savedModelId: "gpt-4o-mini",
};

/** @description The sentinel round-trips to null so the API never receives an empty string. */
test("lt-llm-model-selection-roundtrip: sentinel maps to null, a real model maps to itself", () => {
  assert.equal(resolveLlmModelSelection(LLM_MODEL_DEFAULT_OPTION), null);
  assert.equal(resolveLlmModelSelection(""), null);
  assert.equal(resolveLlmModelSelection("gpt-5.6-terra"), "gpt-5.6-terra");

  assert.equal(llmModelSelectValue(null), LLM_MODEL_DEFAULT_OPTION);
  assert.equal(llmModelSelectValue("gpt-5.6-terra"), "gpt-5.6-terra");

  for (const stored of [null, "gpt-4o-mini", "claude-sonnet-4-6"]) {
    assert.equal(
      resolveLlmModelSelection(llmModelSelectValue(stored)),
      stored,
      `select value for ${String(stored)} must round-trip`,
    );
  }
});

/** @description Every save outcome has distinct pt-br copy; 400 and 409 are never conflated. */
test("lt-llm-model-save-feedback: each outcome has distinct pt-br copy", () => {
  const outcomes = ["saved", "cleared", "invalid", "conflict", "error"];
  const copies = outcomes.map((outcome) => mapLlmModelSaveFeedback(outcome));

  for (const copy of copies) {
    assert.equal(typeof copy, "string");
    assert.ok(copy.length > 0, "copy must be non-empty");
  }
  assert.equal(
    new Set(copies).size,
    outcomes.length,
    "every outcome must be distinguishable to the operator",
  );
});

/** @description The save is offered only when it would actually be correct to press it. */
test("lt-llm-model-save-availability: the truth table of when saving is offered", () => {
  assert.equal(canSaveLlmModel(SAVEABLE), true, "a real change on the saved provider saves");

  for (const busy of ["saving", "savingModel", "validating"]) {
    assert.equal(
      canSaveLlmModel({ ...SAVEABLE, [busy]: true }),
      false,
      `${busy} in flight must block the save`,
    );
  }

  assert.equal(
    canSaveLlmModel({ ...SAVEABLE, savedProvider: null }),
    false,
    "no saved provider means there is nothing to validate the model against",
  );

  // The model PUT carries no provider: saving here would change the OLD provider's model while
  // the screen shows the new one.
  assert.equal(
    canSaveLlmModel({ ...SAVEABLE, selectedProvider: "anthropic" }),
    false,
    "a provider dropdown that disagrees with what is saved must block the save",
  );

  assert.equal(
    canSaveLlmModel({ ...SAVEABLE, modelSelection: llmModelSelectValue(SAVEABLE.savedModelId) }),
    false,
    "selecting what is already saved is not a change",
  );

  // Clearing back to the default IS a change when a model is currently set.
  assert.equal(
    canSaveLlmModel({ ...SAVEABLE, modelSelection: LLM_MODEL_DEFAULT_OPTION }),
    true,
    "returning to the provider default must be saveable",
  );
  assert.equal(
    canSaveLlmModel({
      ...SAVEABLE,
      savedModelId: null,
      modelSelection: LLM_MODEL_DEFAULT_OPTION,
    }),
    false,
    "already on the default is not a change",
  );
});

/** @description The helper copy explains every state in which the Select is inert. */
test("lt-llm-model-help-copy: each blocked state is explained, never left silent", () => {
  const noProvider = llmModelHelpCopy(null, "openai");
  const mismatched = llmModelHelpCopy("openai", "anthropic");
  const ready = llmModelHelpCopy("openai", "openai");

  for (const copy of [noProvider, mismatched, ready]) {
    assert.equal(typeof copy, "string");
    assert.ok(copy.length > 0);
  }
  assert.equal(
    new Set([noProvider, mismatched, ready]).size,
    3,
    "a disabled control must say WHY it is disabled, distinctly per reason",
  );
  assert.ok(LLM_MODEL_DEFAULT_LABEL.length > 0, "the default option must be labelled");
});

/** @description A superseded response must never apply its state over a newer one. */
test("lt-llm-write-sequence-guard: only the newest in-flight write may apply", () => {
  assert.equal(shouldApplyLlmWrite(3, 3), true, "the current write applies");
  assert.equal(shouldApplyLlmWrite(2, 3), false, "a superseded write must not apply");
  assert.equal(shouldApplyLlmWrite(1, 3), false, "an older write must not apply");
});

/** @description A discarded model choice must be named to the operator, never silently reverted. */
test("lt-llm-retired-model-copy: the discarded choice is named, and absent when there is none", () => {
  assert.equal(llmRetiredModelCopy(null), null, "no notice when nothing was discarded");
  const copy = llmRetiredModelCopy("gpt-5.6-luna");
  assert.ok(typeof copy === "string" && copy.length > 0);
  assert.match(
    copy,
    /gpt-5\.6-luna/,
    "the notice must name the model that was dropped, or the operator cannot act on it",
  );
});
