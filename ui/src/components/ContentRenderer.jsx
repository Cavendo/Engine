import { useState, useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export default function ContentRenderer({ content, contentType, maxHeight = 'max-h-96' }) {
  const [allowScripts, setAllowScripts] = useState(false);

  const renderedMarkdown = useMemo(() => {
    if (contentType === 'markdown' || !contentType) {
      const rawHtml = marked.parse(content || '');
      return DOMPurify.sanitize(rawHtml);
    }
    return null;
  }, [content, contentType]);

  if (!content) return null;

  if (contentType === 'html') {
    // sandbox="allow-scripts" lets HTML/CSS/JS render but the iframe gets an
    // opaque origin — it cannot access the parent page's cookies, storage, or DOM.
    // Without the checkbox, scripts are fully sandboxed (no allow-scripts).
    const sandboxValue = allowScripts ? 'allow-scripts' : '';

    return (
      <div>
        <div className="flex items-center gap-2 mb-2 text-sm text-gray-500">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowScripts}
              onChange={(e) => setAllowScripts(e.target.checked)}
              className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            Enable JavaScript
          </label>
          {allowScripts && (
            <span className="text-amber-600 text-xs">Scripts run in an isolated sandbox</span>
          )}
        </div>
        <iframe
          srcDoc={content}
          sandbox={sandboxValue}
          className={`w-full ${maxHeight} border border-gray-200 rounded-lg bg-white`}
          style={{ minHeight: '200px' }}
          title="HTML Preview"
        />
      </div>
    );
  }

  if (contentType === 'code' || contentType === 'json') {
    return (
      <div className={`${maxHeight} overflow-y-auto rounded-lg`}>
        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm font-mono whitespace-pre-wrap overflow-x-auto">
          {content}
        </pre>
      </div>
    );
  }

  if (contentType === 'text') {
    return (
      <div className={`${maxHeight} overflow-y-auto rounded-lg`}>
        <pre className="bg-gray-50 border border-gray-200 p-4 rounded-lg text-sm font-sans whitespace-pre-wrap">
          {content}
        </pre>
      </div>
    );
  }

  // Default: markdown
  return (
    <div
      className={`${maxHeight} overflow-y-auto bg-white border border-gray-200 rounded-lg p-4 prose prose-sm max-w-none prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-code:text-primary-700 prose-code:before:content-none prose-code:after:content-none`}
      dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
    />
  );
}
