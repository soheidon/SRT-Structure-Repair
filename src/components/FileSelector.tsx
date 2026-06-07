import { useCallback, useRef, useState } from "react";

interface FileSelectorProps {
  label: string;
  fileName: string | null;
  disabled: boolean;
  /// Called when a .srt file is loaded (via D&D or click).
  /// `fileName` is the basename of the file, `content` is the file text.
  onFileLoaded: (fileName: string, content: string) => void;
  /// Called to clear this file slot.
  onClear: () => void;
}

export default function FileSelector({
  label,
  fileName,
  disabled,
  onFileLoaded,
  onClear,
}: FileSelectorProps) {
  const [dragOver, setDragOver] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /// Shared logic: read a File object, validate, and notify the parent.
  const processFile = useCallback(
    async (file: File) => {
      setValidationError(null);

      console.log("[D&D] processFile called");
      console.log("[D&D] file name:", file.name);
      console.log("[D&D] file type:", file.type);

      const name = file.name;
      if (!name.toLowerCase().endsWith(".srt")) {
        const msg = `SRTファイルではありません: ${name}（.srtファイルのみ対応しています）`;
        console.log("[D&D] validation: REJECTED —", msg);
        setValidationError(msg);
        return;
      }

      console.log("[D&D] validation: OK");
      try {
        const text = await file.text();
        console.log("[D&D] file text length:", text.length, "chars");
        onFileLoaded(name, text);
      } catch (err) {
        const msg = `ファイルの読み込みに失敗しました: ${err}`;
        console.error("[D&D]", msg);
        setValidationError(msg);
      }
    },
    [onFileLoaded],
  );

  // --- React drag handlers ---
  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("[D&D] dragEnter fired");
      if (disabled) return;
      setDragOver(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      if (!dragOver) setDragOver(true);
    },
    [disabled, dragOver],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("[D&D] dragLeave fired");
      setDragOver(false);
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("[D&D] drop fired");
      setDragOver(false);

      if (disabled) return;

      const files = e.dataTransfer.files;
      console.log("[D&D] dropped file count:", files.length);

      if (files.length === 0) {
        setValidationError(
          "ファイルがドロップされませんでした。",
        );
        return;
      }

      processFile(files[0]);
    },
    [disabled, processFile],
  );

  // --- Click-to-select fallback ---
  const handleClick = useCallback(() => {
    if (disabled) return;
    fileInputRef.current?.click();
  }, [disabled]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      console.log("[D&D] file input changed, count:", files?.length ?? 0);
      if (files && files.length > 0) {
        processFile(files[0]);
      }
      // Reset so the same file can be re-selected
      e.target.value = "";
    },
    [processFile],
  );

  return (
    <div className="file-selector">
      <label className="file-label">{label}</label>
      <div
        className={`file-dropzone ${dragOver ? "drag-over" : ""} ${disabled ? "disabled" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        {fileName ? (
          <span className="file-name">{fileName}</span>
        ) : (
          <span className="file-placeholder">
            クリックまたはSRTファイルをここにドロップ
          </span>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".srt"
          style={{ display: "none" }}
          onChange={handleInputChange}
        />
      </div>
      {fileName && !disabled && (
        <button
          className="file-clear-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
            setValidationError(null);
          }}
        >
          クリア
        </button>
      )}
      {validationError && (
        <div className="drop-error">{validationError}</div>
      )}
    </div>
  );
}
