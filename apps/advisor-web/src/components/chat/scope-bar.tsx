"use client";

import { useEffect, useId, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { memoryApi, type Scope } from "@/lib/memory/client";

type Props = {
  scope: Scope;
  onChange: (change: Partial<Scope>) => void;
  disabled?: boolean;
};

const FIELD =
  "h-8 min-w-0 rounded-md border bg-card px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50";

// The customer and IFS version of the question. Saved answers and notes apply only to them.
// The customer field is only shown when the server has a list of customers (MEMORY_CUSTOMERS), or when a customer
// was already typed in this chat, so it can still be seen and cleared.
export function ScopeBar({ scope, onChange, disabled }: Props) {
  const { t } = useLanguage();
  const listId = useId();
  const [choices, setChoices] = useState<{
    customers: string[];
    versions: string[];
  }>({ customers: [], versions: [] });

  useEffect(() => {
    let cancelled = false;
    memoryApi.scopes().then((res) => {
      if (!cancelled && res.ok) setChoices(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // a version chosen earlier stays selectable even when it is not in the list any more
  const showCustomer = choices.customers.length > 0 || scope.customer !== "";
  const versions =
    scope.ifsVersion && !choices.versions.includes(scope.ifsVersion)
      ? [scope.ifsVersion, ...choices.versions]
      : choices.versions;

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5 md:px-4"
      title={t.scopeHint}
    >
      {showCustomer && (
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">{t.customerLabel}</span>
          <input
            className={`${FIELD} w-40 text-foreground`}
            value={scope.customer}
            maxLength={80}
            placeholder={t.customerPlaceholder}
            list={listId}
            disabled={disabled}
            onChange={(e) => onChange({ customer: e.target.value })}
          />
          <datalist id={listId}>
            {choices.customers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      )}
      <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0">{t.versionLabel}</span>
        <select
          className={`${FIELD} text-foreground`}
          value={scope.ifsVersion}
          disabled={disabled}
          onChange={(e) => onChange({ ifsVersion: e.target.value })}
        >
          <option value="">{t.versionAny}</option>
          {versions.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
