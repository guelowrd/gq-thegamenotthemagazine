// Invite rivals to a record: the X post (Weibo beside it in Chinese) and the plain link.

import { useState } from "react";
import { recordLinks } from "@/lib/flow";
import { useLang, useT } from "@/lib/i18n";
import type { Stage } from "@/lib/stages";

export function ShareButtons({ recordId, score, expiresAt, cities, stage, name }: { recordId: string; score: number; expiresAt: number; cities: string[]; stage?: Stage; name?: string }) {
  const t = useT();
  const { lang } = useLang();
  const { url, x, weibo } = recordLinks(recordId, score, expiresAt, cities, stage, name);
  const [copied, setCopied] = useState(false);
  return (
    <div className="share">
      <a className="btn primary" href={x} target="_blank" rel="noreferrer">
        {t("Share on X")}
      </a>
      {lang === "zh-Hans" && (
        <a className="btn primary" href={weibo} target="_blank" rel="noreferrer">
          {t("Share on Weibo")}
        </a>
      )}
      <button className="btn" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
        {copied ? t("Copied!") : t("Copy link")}
      </button>
    </div>
  );
}
