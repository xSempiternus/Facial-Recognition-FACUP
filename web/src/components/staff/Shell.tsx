"use client";

import clsx from "clsx";
import {
  CalendarCheck,
  ChevronRight,
  FlaskConical,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { LayoutGroup, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, cerrarSesion, escucharPendientes, leerToken, suscribirSesion } from "@/lib/staff-api";
import { nombreSedeGuardado, rutaSede, sedeGuardada } from "@/lib/sede";
import { usePendientes } from "./Pendientes";
import { Skeleton } from "./ui";

type Item = { href: string; texto: string; corto?: string; icono: LucideIcon; exacto?: boolean };

const NAV: Item[] = [
  { href: "/staff", texto: "Hoy", icono: CalendarCheck, exacto: true },
  { href: "/staff/ninos", texto: "Niños", icono: Users },
  { href: "/staff/seguimiento", texto: "Seguimiento", corto: "Seguim.", icono: TrendingUp },
  { href: "/staff/ajustes", texto: "Ajustes", icono: Settings },
];

const MIGAS: Record<string, string> = Object.fromEntries(NAV.map((n) => [n.href, n.texto]));
const EASE = [0.22, 1, 0.36, 1] as const;

function useSesion() {
  // undefined en servidor / hidratación; null = sin sesión; string = token.
  return useSyncExternalStore(
    suscribirSesion,
    () => leerToken(),
    () => undefined,
  );
}

function useNombreSede() {
  return useSyncExternalStore(
    suscribirSesion,
    () => nombreSedeGuardado(),
    () => undefined,
  );
}

/** Cantidad de solicitudes por aprobar: al entrar, al volver a la pestaña, cada minuto y cuando una página lo avisa. */
function usePendientesSolicitudes(activo: boolean, ruta: string) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    const cargar = () =>
      api
        .solicitudes()
        .then((l) => vivo && setN(l.length))
        .catch(() => {
          /* el globo es solo informativo */
        });
    cargar();
    const t = window.setInterval(cargar, 60_000);
    const al = () => document.visibilityState === "visible" && cargar();
    document.addEventListener("visibilitychange", al);
    const off = escucharPendientes((x) => vivo && setN(x));
    return () => {
      vivo = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", al);
      off();
    };
  }, [activo, ruta]);
  return n;
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
  const [paleta, setPaleta] = useState(false);
  const sede = useNombreSede();
  const pendientes = usePendientesSolicitudes(!!token, ruta);
  const { total: porRevisar } = usePendientes();

  useEffect(() => {
    if (token === null) router.replace(rutaSede(sedeGuardada(), "/"));
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

  const activo = (n: Item) => (n.exacto ? ruta === n.href : ruta.startsWith(n.href));
  const actual = NAV.find(activo);
  const salir = () => {
    const volver = rutaSede(sedeGuardada(), "/");
    cerrarSesion();
    router.replace(volver);
  };
  const ir = (href: string) => {
    setPaleta(false);
    router.push(href);
  };

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.5, ease: EASE }}>
      <div className={clsx("s-shell", colapsado && "s-collapsed")}>
        <aside className="s-sidebar" aria-label="Navegación del panel">
          <div className="s-brand">
            <span className="s-logo s-logo-chico" aria-hidden />
            <span className="s-logo-full" role="img" aria-label="FA CUP Chile" />
            <span className="s-brand-t" title={sede}>Staff</span>
          </div>
          <LayoutGroup id="side">
            <nav className="s-nav" data-tour="menu">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="s-link" title={n.texto} data-tour={`nav-${(n.exacto ? "hoy" : n.href.split("/").pop())}`} aria-current={activo(n) ? "page" : undefined}>
                  {activo(n) && <motion.span layoutId="ind-side" className="s-ind" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                  <n.icono size={17} aria-hidden />
                  <span>{n.texto}</span>
                  {n.href === "/staff/ninos" && pendientes > 0 && (
                    <span className="s-count" aria-label={`${pendientes} por aprobar`}>
                      {pendientes}
                    </span>
                  )}
                  {n.href === "/staff" && porRevisar > 0 && (
                    <span className="s-count" aria-label={`${porRevisar} llegadas por revisar`}>
                      {porRevisar}
                    </span>
                  )}
                </Link>
              ))}
              <div className="s-nav-sep">Próximamente</div>
              <span className="s-link s-link-off" aria-disabled="true" title="Evaluación de modelos: próximamente">
                <FlaskConical size={17} aria-hidden />
                <span>Evaluación</span>
                {!colapsado && <span className="soon">pronto</span>}
              </span>
            </nav>
          </LayoutGroup>
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
            >
              {colapsado ? <PanelLeftOpen size={17} aria-hidden /> : <PanelLeftClose size={17} aria-hidden />}
              <span>Contraer</span>
            </button>
          </div>
        </aside>

        <div className="s-main">
          <header className="s-top">
            <span className="s-logo-full s-mobile-only" role="img" aria-label="FA CUP Chile" />
            <nav className="s-crumbs" aria-label="Ubicación">
              <span className="hide-sm">{sede ? `Staff · ${sede}` : "Staff"}</span>
              <ChevronRight size={14} aria-hidden className="hide-sm" />
              <strong>{actual ? MIGAS[actual.href] : "Panel"}</strong>
            </nav>
            <button type="button" className="s-search" onClick={() => setPaleta(true)} aria-label="Buscar o ir a… (Ctrl+K)">
              <Search size={14} aria-hidden />
              <span>Ir a…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button type="button" className="s-btn ghost icon s-mobile-only" aria-label="Cerrar sesión" onClick={salir}>
              <LogOut size={17} />
            </button>
          </header>
          <main className="s-scroll" id="contenido">
            <div className="s-page" key={ruta}>
              {children}
            </div>
          </main>
        </div>

        <LayoutGroup id="tabs">
          <nav className="s-tabbar" aria-label="Navegación del panel">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="s-tab" data-tour={`tab-${(n.exacto ? "hoy" : n.href.split("/").pop())}`} aria-current={activo(n) ? "page" : undefined}>
                {activo(n) && <motion.span layoutId="ind-tab" className="s-ind" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                <n.icono size={20} aria-hidden />
                <span>{n.corto ?? n.texto}</span>
                {n.href === "/staff/ninos" && pendientes > 0 && (
                  <span className="s-count" aria-label={`${pendientes} por aprobar`}>
                    {pendientes}
                  </span>
                )}
                {n.href === "/staff" && porRevisar > 0 && (
                  <span className="s-count" aria-label={`${porRevisar} llegadas por revisar`}>
                    {porRevisar}
                  </span>
                )}
              </Link>
            ))}
          </nav>
        </LayoutGroup>
      </div>
      <Paleta abierta={paleta} onCerrar={() => setPaleta(false)} ir={ir} salir={salir} />
    </MotionConfig>
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
        id="cmd-buscar"
        name="cmd-buscar"
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
