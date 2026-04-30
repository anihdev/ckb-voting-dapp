/**
 * CreatePoll Component
 * ====================
 * Form for creating a new governance poll from the frontend.
 */

import React, { useState } from "react";
import { CreatePollParams } from "../hooks/usePolls";
import { MAX_WEIGHT_UNITS_PER_INTENT, SHANNONS_PER_CKB, VOTER_DEPOSIT_SHANNONS } from "../lib/constants";
import { TxState } from "../lib/types";
import { TxStatus } from "./TxStatus";

interface Props {
  onSubmit: (params: CreatePollParams) => Promise<string>;
  txState: TxState;
}

const DEFAULT_DURATION = 100;

export function CreatePoll({ onSubmit, txState }: Props) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [tokenWeighted, setTokenWeighted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const perUnitCkb = VOTER_DEPOSIT_SHANNONS / SHANNONS_PER_CKB;
  const maxEffectiveCkb = (VOTER_DEPOSIT_SHANNONS * MAX_WEIGHT_UNITS_PER_INTENT) / SHANNONS_PER_CKB;

  const isBusy =
    txState.status !== "idle" &&
    txState.status !== "success" &&
    txState.status !== "error";

  const addOption = () => {
    if (options.length < 10) setOptions([...options, ""]);
  };

  const removeOption = (index: number) => {
    if (options.length <= 2) return;
    setOptions(options.filter((_, currentIndex) => currentIndex !== index));
  };

  const updateOption = (index: number, value: string) => {
    const nextOptions = [...options];
    nextOptions[index] = value;
    setOptions(nextOptions);
  };

  const validate = (): string | null => {
    if (!question.trim()) return "Question is required";
    if (question.length > 256) return "Question exceeds 256 characters";

    const filledOptions = options.filter((option) => option.trim());
    if (filledOptions.length < 2) return "At least 2 non-empty options required";

    for (const option of filledOptions) {
      if (option.length > 64) {
        return `Option "${option.slice(0, 20)}..." exceeds 64 characters`;
      }
    }

    if (duration < 1 || duration > 1000) return "Duration must be 1-1000 epochs";
    return null;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);

    try {
      await onSubmit({
        question: question.trim(),
        options: options.filter((option) => option.trim()),
        durationEpochs: duration,
        tokenWeighted,
      });

      setQuestion("");
      setOptions(["", ""]);
      setDuration(DEFAULT_DURATION);
      setTokenWeighted(false);
      setExpanded(false);
    } catch (caughtError: any) {
      setError(caughtError.message ?? "Transaction failed");
    }
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="card-shell w-full text-left transition hover:-translate-y-0.5"
        style={{ borderStyle: "dashed", borderWidth: 2, borderColor: "var(--line-2)" }}
      >
        <div className="kicker">Poll Creation</div>
        <div className="mt-3 text-2xl">Create Your Own Poll</div>
        <div className="mt-1 text-sm subtle">
          Open your poll builder to define question, options, and voting mode.
        </div>
      </button>
    );
  }

  return (
    <div className="card-shell">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="section-title text-xl">Create New Poll</h2>
        <button onClick={() => setExpanded(false)} className="btn-quiet px-3 py-1.5 text-xs uppercase tracking-[0.1em]">
          Close
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="label">Question</label>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should we vote on?"
            rows={2}
            maxLength={256}
            className="input resize-none"
            disabled={isBusy}
          />
          <div className="hint text-right">{question.length}/256</div>
        </div>

        <div>
          <label className="label">
            Options
            <span className="ml-1 font-normal hint inline">(2-10)</span>
          </label>
          <div className="space-y-2">
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-6 text-right text-sm subtle">{index + 1}.</span>
                <input
                  value={option}
                  onChange={(event) => updateOption(index, event.target.value)}
                  placeholder={`Option ${index + 1}`}
                  maxLength={64}
                  className="input flex-1"
                  disabled={isBusy}
                />
                {options.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeOption(index)}
                    className="btn-danger px-3 py-2 text-xs uppercase tracking-[0.08em]"
                    disabled={isBusy}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          {options.length < 10 && (
            <button
              type="button"
              onClick={addOption}
              disabled={isBusy}
              className="btn-quiet mt-2"
            >
              Add option
            </button>
          )}
        </div>

        <div>
          <label className="label">
            Duration
            <span className="ml-1 font-normal hint inline">(epochs)</span>
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              value={duration}
              onChange={(event) => setDuration(parseInt(event.target.value, 10) || 0)}
              min={1}
              max={1000}
              className="input w-28"
              disabled={isBusy}
            />
            <span className="text-sm subtle">
              ~= {Math.round((duration * 4) / 60)} hours
              <span className="ml-1 hint inline">(1 epoch ~= 4 min)</span>
            </span>
          </div>
          <div className="hint">
            Poll duration is measured in CKB epochs. Closure eligibility begins after the deadline epoch.
          </div>
        </div>

        <label className="alert alert-warn" style={{ display: "grid", gridTemplateColumns: "16px minmax(0, 1fr)", alignItems: "start", columnGap: 10 }}>
          <input
            type="checkbox"
            checked={tokenWeighted}
            onChange={(event) => setTokenWeighted(event.target.checked)}
            disabled={isBusy}
            style={{ marginTop: 2 }}
          />
          <span style={{ lineHeight: 1.5, wordBreak: "break-word" }}>
            Enable capped weighted voting (vote intents can lock more CKB for higher capped weight).
          </span>
        </label>
        <div className="hint">
          Weighted mode cap: 1 unit = {perUnitCkb.toString()} CKB, max {MAX_WEIGHT_UNITS_PER_INTENT.toString()} units ({maxEffectiveCkb.toString()} CKB effective). Extra CKB above cap adds no extra weight.
        </div>

        <div className="alert alert-warn">
          Creating a poll locks a creator deposit in the poll cell until closure (500 CKB minimum in this deployment).
        </div>

        {error && (
          <div className="alert alert-error">
            {error}
          </div>
        )}

        {txState.status !== "idle" && <TxStatus txState={txState} />}

        <button
          type="submit"
          disabled={isBusy}
          className="btn-primary w-full py-3"
        >
          {isBusy ? "Processing..." : "Create Poll on CKB"}
        </button>
      </form>
    </div>
  );
}
