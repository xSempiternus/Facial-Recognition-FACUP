"use client";

import clsx from "clsx";
import { Loader2 } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { ApiError } from "@/lib/staff-api";

export const cn = clsx;

// ------------------------------------------------------------------ datos

/** Carga datos con recarga manual; `clave` fuerza una nueva carga cuando cambia. */
export function useQuery<T>(fn: () => Promise<T>, clave = "") {
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<T | undefined>(undefined);
  const [res, setRes] = useState<{ k: string; error?: ApiError } | null>(null);
  const k = `${clave}:${tick}`;
  const ejecutar = useEffectEvent(fn);

  useEffect(() => {
    let vivo = true;
    ejecutar()
      .then((d) => {
        if (!vivo) return;
        setData(d);
        setRes({ k });
      })
      .catch((e) => {
        if (vivo) setRes({ k, error: e instanceof ApiError ? e : new ApiError(0, "error", "Algo salió mal.") });
      });
    return () => {
      vivo = false;
    };
  }, [k]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const cargando = res?.k !== k;
  return { data, error: cargando ? undefined : res?.error, cargando, reload };
}

// ------------------------------------------------------------------ toasts

type Tono = "ok" | "err" | "info";
type ToastItem = { id: number; tono: Tono; texto: string };
const ToastCtx = createContext<(texto: string, tono?: Tono) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const sig = useRef(0);
  const notificar = useCallback((texto: string, tono: Tono = "ok") => {
    const id = ++sig.current;
    setItems((l) => [...l.slice(-3), { id, tono, texto }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), 4500);
  }, []);
  const Icono = { ok: CircleCheck, err: CircleAlert, info: Info };
  return (
    <ToastCtx.Provider value={notificar}>
      {children}
      <div className="s-toasts" role="status" aria-live="polite">
        {items.map((t) => {
          const I = Icono[t.tono];
          return (
            <div key={t.id} className={cn("s-toast", t.tono)}>
              <I size={16} aria-hidden />
              <span>{t.texto}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------------ básicos

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variante?: "default" | "primary" | "brand" | "ghost" | "danger";
  sm?: boolean;
  icono?: boolean;
  block?: boolean;
  cargando?: boolean;
};

export function Button({ variante = "default", sm, icono, block, cargando, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || cargando}
      className={cn("s-btn", variante !== "default" && variante, sm && "sm", icono && "icon", block && "block", className)}
    >
      {cargando && <Loader2 size={14} className="s-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Badge({ tono, children }: { tono?: "ok" | "warn" | "err"; children: ReactNode }) {
  return <span className={cn("s-badge", tono)}>{children}</span>;
}

export function Skeleton({ w = "100%", h = 14 }: { w?: number | string; h?: number }) {
  return <div className="s-skel" style={{ width: w, height: h }} aria-hidden />;
}

export function SkeletonRows({ n = 5 }: { n?: number }) {
  return (
    <div className="s-card-b" style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-busy="true" aria-label="Cargando">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} h={18} w={`${95 - (i % 3) * 12}%`} />
      ))}
    </div>
  );
}

export function PageHeader({ titulo, descripcion, children }: { titulo: string; descripcion?: string; children?: ReactNode }) {
  return (
    <div className="s-head">
      <div>
        <h1>{titulo}</h1>
        {descripcion && <p>{descripcion}</p>}
      </div>
      {children && <div className="s-actions">{children}</div>}
    </div>
  );
}

export function Vacio({ icono, titulo, texto, children }: { icono: ReactNode; titulo: string; texto?: string; children?: ReactNode }) {
  return (
    <div className="s-empty">
      <div className="ico" aria-hidden>
        {icono}
      </div>
      <h3>{titulo}</h3>
      {texto && <p>{texto}</p>}
      {children}
    </div>
  );
}

export function ErrorCarga({ error, reintentar }: { error: ApiError; reintentar: () => void }) {
  return (
    <div className="s-card">
      <Vacio icono={<CircleAlert size={18} />} titulo="No se pudo cargar" texto={error.message}>
        <Button onClick={reintentar}>Reintentar</Button>
      </Vacio>
    </div>
  );
}

export function Alerta({ tono = "warn", children }: { tono?: "warn" | "err"; children: ReactNode }) {
  return (
    <div className={cn("s-alert", tono)} role={tono === "err" ? "alert" : undefined}>
      <CircleAlert size={16} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function Avatar({ nombre }: { nombre: string }) {
  const ini = nombre
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return (
    <span className="s-avatar" aria-hidden>
      {ini || "?"}
    </span>
  );
}

export function Campo({ etiqueta, ayuda, children }: { etiqueta: string; ayuda?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="s-field">
      <label htmlFor={id}>{etiqueta}</label>
      {children(id)}
      {ayuda && <span className="hint">{ayuda}</span>}
    </div>
  );
}

export function Segmentado<T extends string>({
  valor,
  opciones,
  onChange,
  etiqueta,
}: {
  valor: T;
  opciones: { valor: T; texto: string }[];
  onChange: (v: T) => void;
  etiqueta: string;
}) {
  return (
    <div className="s-seg" role="radiogroup" aria-label={etiqueta}>
      {opciones.map((o) => (
        <button key={o.valor} type="button" role="radio" aria-checked={valor === o.valor} onClick={() => onChange(o.valor)}>
          {o.texto}
        </button>
      ))}
    </div>
  );
}

export function FiltroCategorias({
  categorias,
  valor,
  onChange,
}: {
  categorias: string[];
  valor: string[];
  onChange: (v: string[]) => void;
}) {
  if (!categorias.length) return null;
  return (
    <div className="s-chips" role="group" aria-label="Filtrar por categoría">
      {categorias.map((c) => (
        <button
          key={c}
          type="button"
          className="s-chip"
          aria-pressed={valor.includes(c)}
          onClick={() => onChange(valor.includes(c) ? valor.filter((x) => x !== c) : [...valor, c])}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ diálogo (nativo: foco atrapado y Esc gratis)

export function Dialogo({
  abierto,
  onCerrar,
  titulo,
  children,
  pie,
  ancho,
}: {
  abierto: boolean;
  onCerrar: () => void;
  titulo: string;
  children: ReactNode;
  pie?: ReactNode;
  ancho?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (abierto && !d.open) d.showModal();
    if (!abierto && d.open) d.close();
  }, [abierto]);
  return (
    <dialog
      ref={ref}
      className={cn("s-dialog", ancho && "wide")}
      aria-label={titulo}
      onClose={onCerrar}
      onClick={(e) => {
        if (e.target === ref.current) onCerrar();
      }}
    >
      {abierto && (
        <>
          <div className="s-dialog-h">
            <h2>{titulo}</h2>
          </div>
          <div className="s-dialog-b">{children}</div>
          {pie && <div className="s-dialog-f">{pie}</div>}
        </>
      )}
    </dialog>
  );
}

export function BotonCerrar({ onClick }: { onClick: () => void }) {
  return (
    <Button icono sm variante="ghost" aria-label="Cerrar" onClick={onClick}>
      <X size={16} />
    </Button>
  );
}
