import React, { useState, createContext, useContext, useCallback } from "react";
import { AlertIcon, InfoIcon } from "./Icons";

/**
 * ConfirmDialog - 自定义确认对话框，替代原生 confirm()
 * 通过 ConfirmProvider 提供全局 confirm() 方法
 */
interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve?: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ConfirmState>({
    open: false,
    message: "",
  });

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...options, open: true, resolve });
    });
  }, []);

  const handleClose = (result: boolean) => {
    state.resolve?.(result);
    setState({ open: false, message: "" });
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state.open && (
        <div className="modal-overlay" onClick={() => handleClose(false)}>
          <div
            className="modal"
            style={{ maxWidth: 400 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <span className="modal-title">{state.title || "确认操作"}</span>
            </div>
            <div className="modal-body">
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div
                  style={{
                    flexShrink: 0,
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: state.danger
                      ? "var(--color-danger-light)"
                      : "var(--color-primary-light)",
                    color: state.danger
                      ? "var(--color-danger)"
                      : "var(--color-primary)",
                  }}
                >
                  {state.danger ? <AlertIcon size={18} /> : <InfoIcon size={18} />}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: "var(--color-text-secondary)",
                    lineHeight: 1.7,
                    paddingTop: 6,
                  }}
                >
                  {state.message}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => handleClose(false)}>
                {state.cancelText || "取消"}
              </button>
              <button
                className={state.danger ? "btn btn-danger" : "btn btn-primary"}
                onClick={() => handleClose(true)}
              >
                {state.confirmText || "确认"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
