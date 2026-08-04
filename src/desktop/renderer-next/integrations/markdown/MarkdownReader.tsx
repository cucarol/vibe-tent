import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownReader({ body }: { body: string }) {
  if (!body) {
    return <p className="tn-markdown-empty">正文为空</p>;
  }
  return (
    <div className="tn-markdown-reader" data-testid="focus-markdown-reader">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              target={href?.startsWith("http://") || href?.startsWith("https://") ? "_blank" : undefined}
              rel={href?.startsWith("http://") || href?.startsWith("https://") ? "noreferrer" : undefined}
            >
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
