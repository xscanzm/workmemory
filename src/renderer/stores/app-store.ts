import { create } from "zustand";
import type {
  WorkSegment,
  AppConfig,
  PrivacyRule,
  AiProviderConfig,
  ReportTemplate,
  Report,
  RecorderStatus,
} from "../../shared/types";

interface AppState {
  // Route
  currentRoute: string;
  setRoute: (route: string) => void;

  // Recorder
  recorderStatus: RecorderStatus;
  setRecorderStatus: (status: RecorderStatus) => void;

  // Segments
  segments: WorkSegment[];
  selectedSegment: WorkSegment | null;
  setSegments: (segments: WorkSegment[]) => void;
  setSelectedSegment: (segment: WorkSegment | null) => void;
  updateSegmentInList: (segment: WorkSegment) => void;
  removeSegmentFromList: (id: string) => void;

  // Config
  appConfig: AppConfig | null;
  setAppConfig: (config: AppConfig) => void;

  // Privacy
  privacyRules: PrivacyRule[];
  setPrivacyRules: (rules: PrivacyRule[]) => void;

  // AI
  aiConfigs: AiProviderConfig[];
  setAiConfigs: (configs: AiProviderConfig[]) => void;

  // Templates
  templates: ReportTemplate[];
  setTemplates: (templates: ReportTemplate[]) => void;

  // Reports
  reports: Report[];
  setReports: (reports: Report[]) => void;

  // Toast
  toast: {
    message: string;
    type: "success" | "error" | "info";
    action?: { label: string; onClick: () => void };
  } | null;
  showToast: (
    message: string,
    type?: "success" | "error" | "info",
    action?: { label: string; onClick: () => void }
  ) => void;
  clearToast: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Route
  currentRoute: "/",
  setRoute: (route) => set({ currentRoute: route }),

  // Recorder
  recorderStatus: "initializing",
  setRecorderStatus: (status) => set({ recorderStatus: status }),

  // Segments
  segments: [],
  selectedSegment: null,
  setSegments: (segments) => set({ segments }),
  setSelectedSegment: (segment) => set({ selectedSegment: segment }),
  updateSegmentInList: (segment) =>
    set((state) => ({
      segments: state.segments.map((s) => (s.id === segment.id ? segment : s)),
      selectedSegment: state.selectedSegment?.id === segment.id ? segment : state.selectedSegment,
    })),
  removeSegmentFromList: (id) =>
    set((state) => ({
      segments: state.segments.filter((s) => s.id !== id),
      selectedSegment: state.selectedSegment?.id === id ? null : state.selectedSegment,
    })),

  // Config
  appConfig: null,
  setAppConfig: (config) => set({ appConfig: config }),

  // Privacy
  privacyRules: [],
  setPrivacyRules: (rules) => set({ privacyRules: rules }),

  // AI
  aiConfigs: [],
  setAiConfigs: (configs) => set({ aiConfigs: configs }),

  // Templates
  templates: [],
  setTemplates: (templates) => set({ templates }),

  // Reports
  reports: [],
  setReports: (reports) => set({ reports }),

  // Toast
  toast: null,
  showToast: (message, type = "success", action) => {
    set({ toast: { message, type, action } });
    setTimeout(() => set({ toast: null }), action ? 5000 : 3000);
  },
  clearToast: () => set({ toast: null }),
}));