/**
 * CreatePoll Component
 * ====================
 * Form for creating a new governance poll from the frontend.
 */

import React, { useState } from "react";
import { CreatePollParams } from "../hooks/usePolls";
import {
  MAX_OPTION_BYTES,
  MAX_OPTIONS,
  MAX_QUESTION_BYTES,
  MIN_OPTIONS,
} from "../lib/constants";
import { utf8ByteLength } from "../lib/molecule";
import {
  epochSpanInUnit,
  formatApproxEpochDuration,
  PollDurationUnit,
  pollDurationToEpochs,
} from "../lib/protocolUi";
import { isTransactionInFlight } from "../lib/txLifecycle";
import { TxState } from "../lib/types";
import { TxStatus } from "./TxStatus";

interface Props {
  onSubmit: (params: CreatePollParams) => Promise<string>;
  txState: TxState;
  currentEpoch: bigint;
}

const DEFAULT_DURATION_VALUE = 1;
const DEFAULT_DURATION_UNIT: PollDurationUnit = "days";

export function CreatePoll({ onSubmit, txState, currentEpoch }: Props) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [durationValue, setDurationValue] = useState(DEFAULT_DURATION_VALUE);
  const [durationUnit, setDurationUnit] = useState<PollDurationUnit>(DEFAULT_DURATION_UNIT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const isBusy = submitting || isTransactionInFlight(txState.status);
  const questionBytes = utf8ByteLength(question);
  const durationEpochs = pollDurationToEpochs(durationValue, durationUnit);
  const estimatedDeadline = currentEpoch + BigInt(durationEpochs);

  const addOption = () => {
    if (options.length < MAX_OPTIONS) setOptions([...options, ""]);
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
    if (questionBytes > MAX_QUESTION_BYTES) {
      return `Question exceeds ${MAX_QUESTION_BYTES.toString()} UTF-8 bytes`;
    }

    const filledOptions = options.filter((option) => option.trim());
    if (filledOptions.length < MIN_OPTIONS) return `At least ${MIN_OPTIONS.toString()} non-empty options required`;

    for (const option of filledOptions) {
      if (utf8ByteLength(option) > MAX_OPTION_BYTES) {
        return `Option "${option.slice(0, 20)}..." exceeds ${MAX_OPTION_BYTES.toString()} UTF-8 bytes`;
      }
    }

    if (durationEpochs < 1 || durationEpochs > 1000) {
      return "Duration must convert to 1-1000 whole epochs";
    }
    return null;
  };

  const changeDurationUnit = (nextUnit: PollDurationUnit) => {
    const preservedEpochs = Math.max(1, durationEpochs);
    setDurationValue(epochSpanInUnit(preservedEpochs, nextUnit));
    setDurationUnit(nextUnit);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      await onSubmit({
        question: question.trim(),
        options: options.filter((option) => option.trim()),
        durationEpochs,
      });

      setQuestion("");
      setOptions(["", ""]);
      setDurationValue(DEFAULT_DURATION_VALUE);
      setDurationUnit(DEFAULT_DURATION_UNIT);
      setExpanded(false);
    } catch (caughtError: any) {
      setError(caughtError.message ?? "Transaction failed");
    } finally {
      setSubmitting(false);
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
          Open your poll builder to define question, options, and duration.
        </div>
      </button>
    );
  }

  return (
    <div className="card-shell">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="section-title text-xl">Create New Poll</h2>
        <button
          onClick={() => setExpanded(false)}
          disabled={isBusy}
          className="btn-quiet px-3 py-1.5 text-xs uppercase"
        >
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
          <div className="hint text-right">{questionBytes.toString()}/{MAX_QUESTION_BYTES.toString()} UTF-8 bytes</div>
        </div>

        <div>
          <label className="label">
            Options
            <span className="ml-1 font-normal hint inline">({MIN_OPTIONS.toString()}-{MAX_OPTIONS.toString()})</span>
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
                    className="btn-danger px-3 py-2 text-xs uppercase"
                    disabled={isBusy}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          {options.length < MAX_OPTIONS && (
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
          <label className="label">Voting duration</label>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="number"
              value={durationValue}
              onChange={(event) => setDurationValue(Number(event.target.value))}
              min={durationUnit === "days" ? 0.25 : 1}
              max={durationUnit === "days" ? 166.6667 : durationUnit === "hours" ? 4000 : 1000}
              step={durationUnit === "days" ? 0.25 : 1}
              className="input w-full sm:w-32"
              disabled={isBusy}
            />
            <div
              role="group"
              aria-label="Voting duration unit"
              className="grid w-full grid-cols-3 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface-2)] sm:w-64"
            >
              {(["hours", "days", "epochs"] as PollDurationUnit[]).map((unit) => (
                <button
                  key={unit}
                  type="button"
                  onClick={() => changeDurationUnit(unit)}
                  disabled={isBusy}
                  aria-pressed={durationUnit === unit}
                  className="min-h-10 px-3 text-xs font-semibold capitalize transition"
                  style={
                    durationUnit === unit
                      ? { background: "var(--teal-dim)", color: "var(--teal)" }
                      : { color: "var(--ink-2)" }
                  }
                >
                  {unit}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 text-sm subtle">
            Protocol duration: {formatApproxEpochDuration(BigInt(Math.max(0, durationEpochs)))}
          </div>
          <div className="hint">
            Estimated deadline: epoch {estimatedDeadline.toString()}. Close becomes valid after that epoch.
          </div>
          <div className="hint">
            Hours and days use CKB's approximate four-hour epoch target and round up. The on-chain epoch deadline remains authoritative.
          </div>
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
