import React, { useEffect, useState, useRef } from "react";

const api = window.workmemory;

type PetStatus = "recording" | "paused" | "privacy_mode" | "error" | "initializing";
type Character = "cat" | "robot" | "ghost" | "droplet" | "fox" | "star";

const CHARACTERS: Character[] = ["cat", "robot", "ghost", "droplet", "fox", "star"];

export function DesktopPet() {
  const [status, setStatus] = useState<PetStatus>("recording");
  const [character, setCharacter] = useState<Character>("cat");
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragMoved = useRef(false);

  useEffect(() => {
    // 获取初始状态和形象配置
    api.getRecorderStatus().then((s) => setStatus(s as PetStatus));
    api.getPetConfig().then((cfg) => {
      if (cfg.character) setCharacter(cfg.character as Character);
    });

    const unsubStatus = api.onPetStatus((s) => setStatus(s as PetStatus));
    const unsubChar = api.onPetCharacterChange((c) => setCharacter(c as Character));

    return () => {
      unsubStatus();
      unsubChar();
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      setDragging(true);
      dragMoved.current = false;
      dragStart.current = { x: e.screenX, y: e.screenY };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const deltaX = e.screenX - dragStart.current.x;
    const deltaY = e.screenY - dragStart.current.y;
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      dragMoved.current = true;
    }
    dragStart.current = { x: e.screenX, y: e.screenY };
    api.petDrag(deltaX, deltaY);
  };

  const handleMouseUp = () => {
    setDragging(false);
  };

  const handleClick = () => {
    // 如果是拖动，不触发点击
    if (dragMoved.current) {
      dragMoved.current = false;
      return;
    }
    api.petClick();
  };

  const handleDoubleClick = () => {
    api.petCycleCharacter();
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    api.petToggleMain();
  };

  const statusColor: Record<PetStatus, string> = {
    recording: "#10b981",
    paused: "#f59e0b",
    privacy_mode: "#8b5cf6",
    error: "#ef4444",
    initializing: "#6b7280",
  };

  return (
    <div
      style={{
        width: 120,
        height: 120,
        position: "relative",
        cursor: dragging ? "grabbing" : "grab",
        userSelect: "none",
        ...({ WebkitAppRegion: "drag" } as React.CSSProperties),
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      title="左键：打开主窗口 | 双击：切换形象 | 右键：显示/隐藏主窗口 | 拖动：移动位置"
    >
      <svg width="120" height="120" viewBox="0 0 120 120" style={{ overflow: "visible" }}>
        <PetCharacter character={character} status={status} color={statusColor[status]} />
      </svg>

      {/* 状态指示点 */}
      <div
        style={{
          position: "absolute",
          top: 8,
          right: 14,
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: statusColor[status],
          boxShadow: `0 0 8px ${statusColor[status]}`,
          animation: status === "recording" ? "petPulse 2s infinite" : "none",
        }}
      />

      {/* 暂停时的 zzz */}
      {status === "paused" && (
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 8,
            fontSize: 14,
            color: "#9ca3af",
            animation: "petFloat 3s infinite",
          }}
        >
          zzz
        </div>
      )}
    </div>
  );
}

interface PetCharacterProps {
  character: Character;
  status: PetStatus;
  color: string;
}

function PetCharacter({ character, status, color }: PetCharacterProps) {
  const sleeping = status === "paused";
  const hiding = status === "privacy_mode";
  const opacity = hiding ? 0.4 : 1;

  switch (character) {
    case "cat":
      return <CatSprite color={color} sleeping={sleeping} opacity={opacity} />;
    case "robot":
      return <RobotSprite color={color} sleeping={sleeping} opacity={opacity} />;
    case "ghost":
      return <GhostSprite color={color} sleeping={sleeping} opacity={opacity} />;
    case "droplet":
      return <DropletSprite color={color} sleeping={sleeping} opacity={opacity} />;
    case "fox":
      return <FoxSprite color={color} sleeping={sleeping} opacity={opacity} />;
    case "star":
      return <StarSprite color={color} sleeping={sleeping} opacity={opacity} />;
  }
}

// === 猫咪 ===
function CatSprite({ color, sleeping, opacity }: { color: string; sleeping: boolean; opacity: number }) {
  return (
    <g opacity={opacity} style={{ animation: "petBreathe 3s infinite ease-in-out", transformOrigin: "60px 60px" }}>
      {/* 身体 */}
      <ellipse cx="60" cy="70" rx="32" ry="26" fill={color} />
      {/* 头 */}
      <circle cx="60" cy="48" r="24" fill={color} />
      {/* 耳朵 */}
      <polygon points="42,32 38,16 52,28" fill={color} />
      <polygon points="78,32 82,16 68,28" fill={color} />
      <polygon points="44,28 42,20 48,26" fill="#fff" opacity="0.4" />
      <polygon points="76,28 78,20 72,26" fill="#fff" opacity="0.4" />
      {/* 眼睛 */}
      {sleeping ? (
        <>
          <path d="M50 46 Q54 49 58 46" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M62 46 Q66 49 70 46" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="54" cy="47" r="3.5" fill="#1f2937">
            <animate attributeName="ry" values="3.5;3.5;0.3;3.5" dur="4s" repeatCount="indefinite" />
          </circle>
          <circle cx="66" cy="47" r="3.5" fill="#1f2937">
            <animate attributeName="ry" values="3.5;3.5;0.3;3.5" dur="4s" repeatCount="indefinite" />
          </circle>
        </>
      )}
      {/* 鼻子 */}
      <path d="M58 54 L60 56 L62 54 Z" fill="#ec4899" />
      {/* 嘴 */}
      <path d="M60 56 Q57 59 55 58" stroke="#1f2937" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M60 56 Q63 59 65 58" stroke="#1f2937" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      {/* 胡须 */}
      <line x1="40" y1="52" x2="48" y2="53" stroke="#1f2937" strokeWidth="1" opacity="0.5" />
      <line x1="40" y1="55" x2="48" y2="55" stroke="#1f2937" strokeWidth="1" opacity="0.5" />
      <line x1="72" y1="53" x2="80" y2="52" stroke="#1f2937" strokeWidth="1" opacity="0.5" />
      <line x1="72" y1="55" x2="80" y2="55" stroke="#1f2937" strokeWidth="1" opacity="0.5" />
      {/* 尾巴 */}
      <path d="M88 75 Q100 70 98 55" stroke={color} strokeWidth="8" fill="none" strokeLinecap="round" style={{ animation: "petWag 2s infinite" }} />
    </g>
  );
}

// === 机器人 ===
function RobotSprite({ color, sleeping, opacity }: { color: string; sleeping: boolean; opacity: number }) {
  return (
    <g opacity={opacity} style={{ animation: "petBreathe 3s infinite ease-in-out", transformOrigin: "60px 60px" }}>
      {/* 天线 */}
      <line x1="60" y1="20" x2="60" y2="32" stroke="#6b7280" strokeWidth="2" />
      <circle cx="60" cy="18" r="4" fill={color}>
        <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite" />
      </circle>
      {/* 头 */}
      <rect x="38" y="32" width="44" height="36" rx="8" fill={color} />
      <rect x="38" y="32" width="44" height="36" rx="8" fill="none" stroke="#1f2937" strokeWidth="1.5" opacity="0.3" />
      {/* 眼睛屏幕 */}
      <rect x="44" y="40" width="32" height="16" rx="3" fill="#1f2937" />
      {sleeping ? (
        <text x="60" y="52" textAnchor="middle" fontSize="10" fill="#10b981" fontFamily="monospace">- -</text>
      ) : (
        <>
          <circle cx="52" cy="48" r="3" fill="#10b981">
            <animate attributeName="r" values="3;3;0.5;3" dur="4s" repeatCount="indefinite" />
          </circle>
          <circle cx="68" cy="48" r="3" fill="#10b981">
            <animate attributeName="r" values="3;3;0.5;3" dur="4s" repeatCount="indefinite" />
          </circle>
        </>
      )}
      {/* 嘴 */}
      <rect x="50" y="60" width="20" height="3" rx="1.5" fill="#1f2937" opacity="0.5" />
      {/* 身体 */}
      <rect x="42" y="70" width="36" height="32" rx="6" fill={color} />
      <rect x="42" y="70" width="36" height="32" rx="6" fill="none" stroke="#1f2937" strokeWidth="1.5" opacity="0.3" />
      {/* 身体按钮 */}
      <circle cx="52" cy="82" r="3" fill="#fff" opacity="0.6" />
      <circle cx="60" cy="82" r="3" fill="#fff" opacity="0.6" />
      <circle cx="68" cy="82" r="3" fill="#fff" opacity="0.6" />
      <rect x="48" y="90" width="24" height="4" rx="2" fill="#1f2937" opacity="0.3" />
    </g>
  );
}

// === 小幽灵 ===
function GhostSprite({ color, sleeping, opacity }: { color: string; sleeping: boolean; opacity: number }) {
  return (
    <g opacity={opacity} style={{ animation: "petFloat 3s infinite ease-in-out", transformOrigin: "60px 60px" }}>
      <path
        d="M60 20 C40 20 32 38 32 58 L32 92 Q36 88 40 92 Q44 96 48 92 Q52 88 56 92 Q60 96 64 92 Q68 88 72 92 Q76 96 80 92 Q84 88 88 92 L88 58 C88 38 80 20 60 20 Z"
        fill={color}
      />
      {/* 眼睛 */}
      {sleeping ? (
        <>
          <path d="M48 48 Q52 51 56 48" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M64 48 Q68 51 72 48" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <ellipse cx="52" cy="48" rx="4" ry="5" fill="#fff" />
          <ellipse cx="68" cy="48" rx="4" ry="5" fill="#fff" />
          <circle cx="52" cy="49" r="2" fill="#1f2937" />
          <circle cx="68" cy="49" r="2" fill="#1f2937" />
        </>
      )}
      {/* 嘴 */}
      <ellipse cx="60" cy="60" rx="4" ry="5" fill="#1f2937" opacity="0.6" />
    </g>
  );
}

// === 水滴 ===
function DropletSprite({ color, sleeping, opacity }: { color: string; sleeping: boolean; opacity: number }) {
  return (
    <g opacity={opacity} style={{ animation: "petBreathe 3s infinite ease-in-out", transformOrigin: "60px 60px" }}>
      <path
        d="M60 18 C60 18 38 48 38 68 C38 84 48 96 60 96 C72 96 82 84 82 68 C82 48 60 18 60 18 Z"
        fill={color}
      />
      {/* 高光 */}
      <ellipse cx="50" cy="56" rx="6" ry="12" fill="#fff" opacity="0.4" />
      {/* 眼睛 */}
      {sleeping ? (
        <>
          <path d="M50 64 Q54 67 58 64" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M62 64 Q66 67 70 64" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="54" cy="65" r="3" fill="#1f2937">
            <animate attributeName="ry" values="3;3;0.3;3" dur="4s" repeatCount="indefinite" />
          </circle>
          <circle cx="66" cy="65" r="3" fill="#1f2937">
            <animate attributeName="ry" values="3;3;0.3;3" dur="4s" repeatCount="indefinite" />
          </circle>
        </>
      )}
      {/* 嘴 */}
      <path d="M56 74 Q60 78 64 74" stroke="#1f2937" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </g>
  );
}

// === 狐狸 ===
function FoxSprite({ color, sleeping, opacity }: { color: string; sleeping: boolean; opacity: number }) {
  return (
    <g opacity={opacity} style={{ animation: "petBreathe 3s infinite ease-in-out", transformOrigin: "60px 60px" }}>
      {/* 尾巴 */}
      <path d="M88 70 Q104 60 100 40 Q92 48 86 60" fill={color} style={{ animation: "petWag 2s infinite", transformOrigin: "88px 70px" }} />
      <path d="M88 70 Q104 60 100 40" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" opacity="0.5" />
      {/* 身体 */}
      <ellipse cx="58" cy="72" rx="28" ry="22" fill={color} />
      {/* 头 */}
      <path d="M60 30 L36 52 L42 58 L60 50 L78 58 L84 52 Z" fill={color} />
      {/* 脸 */}
      <path d="M60 42 L48 56 L60 62 L72 56 Z" fill="#fff" opacity="0.9" />
      {/* 眼睛 */}
      {sleeping ? (
        <>
          <path d="M50 50 Q53 52 56 50" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M64 50 Q67 52 70 50" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="53" cy="50" r="2.5" fill="#1f2937" />
          <circle cx="67" cy="50" r="2.5" fill="#1f2937" />
        </>
      )}
      {/* 鼻子 */}
      <circle cx="60" cy="58" r="2.5" fill="#1f2937" />
    </g>
  );
}

// === 星星精灵 ===
function StarSprite({ color, sleeping, opacity }: { color: string; sleeping: boolean; opacity: number }) {
  return (
    <g opacity={opacity} style={{ animation: "petSpin 8s infinite linear", transformOrigin: "60px 60px" }}>
      <path
        d="M60 20 L68 48 L96 48 L74 64 L82 92 L60 76 L38 92 L46 64 L24 48 L52 48 Z"
        fill={color}
        stroke="#fff"
        strokeWidth="1.5"
        opacity="0.9"
      />
      {/* 眼睛 */}
      {sleeping ? (
        <>
          <path d="M52 56 Q55 58 58 56" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M62 56 Q65 58 68 56" stroke="#1f2937" strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="55" cy="56" r="3" fill="#1f2937">
            <animate attributeName="ry" values="3;3;0.3;3" dur="4s" repeatCount="indefinite" />
          </circle>
          <circle cx="65" cy="56" r="3" fill="#1f2937">
            <animate attributeName="ry" values="3;3;0.3;3" dur="4s" repeatCount="indefinite" />
          </circle>
        </>
      )}
      {/* 嘴 */}
      <path d="M57 64 Q60 67 63 64" stroke="#1f2937" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </g>
  );
}
