import { FileText, Download } from 'lucide-react';

export default function FileList({ files }) {
  if (!files || files.length === 0) return null;

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-700 mb-2">Files ({files.length})</h4>
      <div className="space-y-2">
        {files.map((file, i) => (
          <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors">
            <FileText className="w-5 h-5 text-gray-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-mono truncate">{file.filename}</div>
              {file.mimeType && (
                <span className="inline-block mt-0.5 text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">
                  {file.mimeType}
                </span>
              )}
            </div>
            {file.path && (
              <a
                href={`/uploads/${file.path}`}
                download={file.filename}
                className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-800 flex-shrink-0"
              >
                <Download className="w-4 h-4" />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
