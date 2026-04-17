/**
 * CreatePoll Component
 * ====================
 * Form for creating a new governance poll from the frontend.
 */

import React, { useState } from "react";
import { CreatePollParams } from "../hooks/usePolls";
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
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

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
      });

      setQuestion("");
      setOptions(["", ""]);
      setDuration(DEFAULT_DURATION);
      setExpanded(false);
    } catch (caughtError: any) {
      setError(caughtError.message ?? "Transaction failed");
    }
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full rounded-xl border-2 border-dashed border-blue-300 p-6 text-lg font-medium text-blue-500 transition-all hover:border-blue-500 hover:bg-blue-50"
      >
        + Create New Poll
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-800">Create New Poll</h2>
        <button onClick={() => setExpanded(false)} className="text-xl text-gray-400 hover:text-gray-600">
          x
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="mb-1.5 block text-sm font-semibold text-gray-700">
            Question
          </label>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should we vote on?"
            rows={2}
            maxLength={256}
            className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isBusy}
          />
          <div className="mt-0.5 text-right text-xs text-gray-400">{question.length}/256</div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-semibold text-gray-700">
            Options
            <span className="ml-1 font-normal text-gray-400">(2-10)</span>
          </label>
          <div className="space-y-2">
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-6 text-right text-sm text-gray-400">{index + 1}.</span>
                <input
                  value={option}
                  onChange={(event) => updateOption(index, event.target.value)}
                  placeholder={`Option ${index + 1}`}
                  maxLength={64}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isBusy}
                />
                {options.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeOption(index)}
                    className="text-lg leading-none text-gray-300 hover:text-red-400"
                    disabled={isBusy}
                  >
                    x
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
              className="mt-2 text-sm font-medium text-blue-500 hover:text-blue-700"
            >
              + Add option
            </button>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-semibold text-gray-700">
            Duration
            <span className="ml-1 font-normal text-gray-400">(epochs)</span>
          </label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              value={duration}
              onChange={(event) => setDuration(parseInt(event.target.value, 10) || 0)}
              min={1}
              max={1000}
              className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isBusy}
            />
            <span className="text-sm text-gray-500">
              ~= {Math.round((duration * 4) / 60)} hours
              <span className="ml-1 text-gray-400">(1 epoch ~= 4 min)</span>
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Creating a poll locks 500 CKB as the creator deposit until the poll is closed.
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}

        {txState.status !== "idle" && <TxStatus txState={txState} />}

        <button
          type="submit"
          disabled={isBusy}
          className="w-full rounded-lg bg-blue-600 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:bg-blue-300"
        >
          {isBusy ? "Processing..." : "Create Poll on CKB"}
        </button>
      </form>
    </div>
  );
}
