import React from "react";
import { useAppStore } from "../stores/app-store";
import { CheckIcon, AlertIcon, InfoIcon, UndoIcon } from "./Icons";

export function Toast() {
  const { toast, clearToast } = useAppStore();

  if (!toast) return null;

  const icons = {
    success: <CheckIcon size={16} />,
    error: <AlertIcon size={16} />,
    info: <InfoIcon size={16} />,
  };

  return (
    <div className={`toast ${toast.type}`}>
      {icons[toast.type]}
      <span>{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action?.onClick();
            clearToast();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
