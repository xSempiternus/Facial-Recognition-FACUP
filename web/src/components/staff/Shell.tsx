"use client";

import clsx from "clsx";
import {
  CalendarCheck,
  ChevronRight,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  TrendingUp,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cerrarSesion, leerToken, suscribirSesion } from "@/lib/staff-api";
import { Skeleton } from "./ui";

type Item = { href: string; texto: string; icono: LucideIcon; exacto?: boolean };

const NAV: Item[] = [
  { href: "/staff", texto: "Resumen", icono: LayoutDashboard, exacto: true },
  { href: "/staff/asistencia", texto: "Asistencia", icono: CalendarCheck },
  { href: "/staff/jugadores", texto: "Jugadores", icono: Users },
  { href: "/staff/inscribir", texto: "Inscribir", icono: UserPlus },
  { href: "/staff/reportes", texto: "Reportes", icono: TrendingUp },
  { href: "/staff/ajustes", texto: "Ajustes", icono: Settings },
];

const MIGAS: Record<string, string> = Object.fromEntries(NAV.map((n) => [n.href, n.texto]));

function useSesion() {
  // undefined en servidor / hidratación; null = sin sesión; string = token.
  return useSyncExternalStore(
    suscribirSesion,
    () => leerToken(),
    () => undefined,
  );
}

function usePrefColapsado() {
  const [v, setV] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- lectura única tras hidratar
      setV(window.localStorage.getItem("facup-staff-colapsado") === "1");
    } catch {
      /* sin preferencia guardada */
    }
  }, []);
  const set = (x: boolean) => {
    setV(x);
    try {
      window.localStorage.setItem("facup-staff-colapsado", x ? "1" : "0");
    } catch {
      /* solo es una comodidad */
    }
  };
  return [v, set] as const;
}

export function Shell({ children }: { children: ReactNode }) {
  const token = useSesion();
  const router = useRouter();
  const ruta = usePathname();
  const [colapsado, setColapsado] = usePrefColapsado();
  const [abierto, setAbierto] = useState(false);
  const [paleta, setPaleta] = useState(false);

  useEffect(() => {
    if (token === null) router.replace("/staff/login");
  }, [token, router]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaleta(true);
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  if (!token) {
    return (
      <div className="s-main" aria-busy="true" aria-label="Cargando">
        <div className="s-page" style={{ gap: 14 }}>
          <Skeleton w={220} h={28} />
          <Skeleton h={120} />
        </div>
      </div>
    );
  }

  const actual = NAV.find((n) => (n.exacto ? ruta === n.href : ruta.startsWith(n.href)));
  const salir = () => {
    cerrarSesion();
    router.replace("/staff/login");
  };
  const ir = (href: string) => {
    setPaleta(false);
    setAbierto(false);
    router.push(href);
  };

  return (
    <div className={clsx("s-main", "s-shell")} style={{ flexDirection: "row" }}>
      <div className={clsx(colapsado && "s-collapsed", abierto && "s-open")} style={{ display: "contents" }}>
        <aside className="s-sidebar" aria-label="Navegación del panel">
          <div className="s-brand">
            <span className="s-logo" aria-hidden />
            <span>FA CUP · Staff</span>
          </div>
          <nav className="s-nav">
            {NAV.map(({ href, texto, icono: I, exacto }) => (
              <Link
                key={href}
                href={href}
                className="s-link"
                title={texto}
                aria-current={(exacto ? ruta === href : ruta.startsWith(href)) ? "page" : undefined}
                onClick={() => setAbierto(false)}
              >
                <I size={17} aria-hidden />
                <span>{texto}</span>
              </Link>
            ))}
            <div className="s-nav-sep">Próximamente</div>
            <span className="s-link" aria-disabled="true" title="Evaluación de modelos: próximamente" style={{ cursor: "default", opacity: 0.6 }}>
              <FlaskConical size={17} aria-hidden />
              <span>Evaluación</span>
              {!colapsado && <span className="soon">pronto</span>}
            </span>
          </nav>
          <div className="s-foot">
            <button type="button" className="s-link" onClick={salir} title="Cerrar sesión">
              <LogOut size={17} aria-hidden />
              <span>Cerrar sesión</span>
            </button>
            <button
              type="button"
              className="s-link"
              onClick={() => setColapsado(!colapsado)}
              aria-label={colapsado ? "Expandir menú" : "Contraer menú"}
              title={colapsado ? "Expandir menú" : "Contraer menú"}
              style={{ display: abierto ? "none" : undefined }}
            >
              {colapsado ? <PanelLeftOpen size={17} aria-hidden /> : <PanelLeftClose size={17} aria-hidden />}
              <span>Contraer</span>
            </button>
          </div>
        </aside>
        <div className="s-scrim" onClick={() => setAbierto(false)} aria-hidden />

        <div className="s-main">
          <header className="s-top">
            <button type="button" className="s-btn ghost icon s-mobile-only" aria-label="Abrir menú" onClick={() => setAbierto(true)}>
              <Menu size={18} />
            </button>
            <nav className="s-crumbs" aria-label="Ubicación">
              <span className="hide-sm">Staff</span>
              <ChevronRight size={14} aria-hidden className="hide-sm" />
              <strong>{actual ? MIGAS[actual.href] : "Panel"}</strong>
            </nav>
            <button type="button" className="s-search" onClick={() => setPaleta(true)} aria-label="Buscar o ir a… (Ctrl+K)">
              <Search size={14} aria-hidden />
              <span>Ir a…</span>
              <kbd>Ctrl K</kbd>
            </button>
          </header>
          <main className="s-scroll" id="contenido">
            <div className="s-page">{children}</div>
          </main>
        </div>
      </div>
      <Paleta abierta={paleta} onCerrar={() => setPaleta(false)} ir={ir} salir={salir} />
    </div>
  );
}

function Paleta({ abierta, onCerrar, ir, salir }: { abierta: boolean; onCerrar: () => void; ir: (h: string) => void; salir: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (abierta && !d.open) d.showModal();
    if (!abierta && d.open) d.close();
  }, [abierta]);

  const acciones: { texto: string; icono: LucideIcon; run: () => void }[] = [
    ...NAV.map((n) => ({ texto: `Ir a ${n.texto}`, icono: n.icono, run: () => ir(n.href) })),
    { texto: "Cerrar sesión", icono: LogOut, run: salir },
  ];
  const lista = acciones.filter((a) => a.texto.toLowerCase().includes(q.trim().toLowerCase()));
  const idx = Math.min(sel, Math.max(lista.length - 1, 0));

  return (
    <dialog
      ref={ref}
      className="s-cmd"
      aria-label="Paleta de comandos"
      onClose={() => {
        setQ("");
        setSel(0);
        onCerrar();
      }}
      onClick={(e) => e.target === ref.current && onCerrar()}
    >
      <input
        value={q}
        placeholder="Escribe para buscar…"
        aria-label="Buscar acción"
        role="combobox"
        aria-expanded="true"
        aria-controls="cmd-lista"
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel(Math.min(idx + 1, lista.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel(Math.max(idx - 1, 0));
          } else if (e.key === "Enter" && lista[idx]) {
            e.preventDefault();
            lista[idx].run();
          }
        }}
      />
      {lista.length === 0 ? (
        <div className="none">Sin resultados</div>
      ) : (
        <ul id="cmd-lista" role="listbox">
          {lista.map((a, i) => (
            <li key={a.texto} role="presentation">
              <button type="button" role="option" aria-selected={i === idx} onMouseEnter={() => setSel(i)} onClick={a.run}>
                <a.icono size={16} aria-hidden />
                {a.texto}
              </button>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
