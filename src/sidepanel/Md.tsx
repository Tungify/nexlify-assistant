// Markdown for assistant output. Links always open in a new tab: inside the
// Featurebase iframe a plain link would replace the chat with no way back.
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

const components: Components = {
  a: ({ node: _node, children, ...rest }) => (
    <a {...rest} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export function Md({ text, code = false, className }: { text: string; code?: boolean; className?: string }) {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={code ? [rehypeHighlight] : []} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

// Safety net for any other link in the panel (merchant card, future UI): open
// http(s) links in a new tab instead of navigating the panel itself.
export function keepLinksOutOfPanel() {
  document.addEventListener(
    "click",
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || !/^https?:/i.test(a.href)) return;
      e.preventDefault();
      window.open(a.href, "_blank", "noopener,noreferrer");
    },
    true,
  );
}
