// Invite rivals to a record: the X post and the plain link.

import { useState } from "react";
import { recordLinks } from "@/lib/flow";

export function ShareButtons({ recordId, score }: { recordId: string; score: number }) {
  const { url, x } = recordLinks(recordId, score);
  const [copied, setCopied] = useState(false);
  return (
    <div className="share">
      <a className="btn primary" href={x} target="_blank" rel="noreferrer">
        Share on X
      </a>
      <button className="btn" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}
