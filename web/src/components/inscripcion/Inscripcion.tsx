"use client";

// Formulario público para padres (/s/<sede>/inscripcion?t=<token>): bienvenida -> Hijo/a -> Apoderado (datos y
// autorizaciones) -> Fotos -> Listo. Misma estética que el menú: foto de fondo, cristal oscuro, verde de marca.
// Pensado para el teléfono en la mano. Sin sonidos. "Inscribir a otro hijo/a" reutiliza los datos del apoderado
// solo en memoria del navegador (no se guarda nada extra en el servidor ni en el almacenamiento local).

import { AnimatePresence, MotionConfig, motion, useMotionValue } from "motion/react";
import { ArrowLeft, CheckCircle2, Loader2, Lock, ScanFace, Timer, UserPlus } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import FondoVivo from "@/components/kiosko/FondoVivo";
import { iniciarCalidad } from "@/components/kiosko/calidad";
import {
  enviarInscripcion,
  ErrorInscripcion,
  infoInscripcion,
  normalizarCorreo,
  normalizarTelefono,
  telefonoLegible,
  type InfoInscripcion,
  type Parentesco,
} from "@/lib/inscripcion-api";
import { FotosPaso, type Foto } from "./Fotos";

const EASE = [0.22, 1, 0.36, 1] as const;
const NOMBRE_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]{1,59}$/;
const NO_SE = "__no_se"; // "No estoy seguro/a": la categoría queda pendiente y la completa el staff al aprobar

// Pasos internos y la etapa que muestra la barra de progreso.
const P = { bienvenida: 0, hijo: 1, apoderado: 2, autorizacion: 3, fotos: 4, listo: 5 } as const;
const ETAPAS = ["Hijo/a", "Apoderado", "Fotos", "Listo"] as const;
const ETAPA_DE_PASO = [-1, 0, 1, 1, 2, 3];

type Campo = "nombre" | "anio" | "categoria" | "tutor" | "parentesco" | "correo" | "telefono";
type Errores = Partial<Record<Campo, string>>;
type Carga = { estado: "cargando" } | { estado: "invalido" } | { estado: "red"; mensaje: string } | { estado: "ok"; info: InfoInscripcion };

const CAMPO_SERVIDOR: Record<string, Campo> = {
  nombre_nino: "nombre",
  anio_nacimiento: "anio",
  categoria: "categoria",
  tutor_nombre: "tutor",
  tutor_parentesco: "parentesco",
  tutor_correo: "correo",
  tutor_telefono: "telefono",
  tutor_contacto: "correo",
};
const ID_CAMPO: Record<Campo, string> = {
  nombre: "ins-nombre",
  anio: "ins-anio",
  categoria: "ins-categoria",
  tutor: "ins-tutor",
  parentesco: "ins-parentesco-madre",
  correo: "ins-correo",
  telefono: "ins-telefono",
};
const PASO_DE_CAMPO: Record<Campo, number> = { nombre: P.hijo, anio: P.hijo, categoria: P.hijo, tutor: P.apoderado, parentesco: P.apoderado, correo: P.apoderado, telefono: P.apoderado };
const PARENTESCOS: { valor: Exclude<Parentesco, "">; texto: string }[] = [
  { valor: "madre", texto: "Madre" },
  { valor: "padre", texto: "Padre" },
  { valor: "otro", texto: "Otro" },
];

const limpio = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

function validarHijo(d: { nombre: string; anio: string; categoria: string }, pideCategoria: boolean): Errores {
  const e: Errores = {};
  const nombre = limpio(d.nombre);
  if (!NOMBRE_RE.test(nombre) || !nombre.includes(" ")) e.nombre = "Escribe el nombre y apellido del niño o niña (solo letras).";
  const anio = Number(d.anio);
  const hoy = new Date().getFullYear();
  if (!/^\d{4}$/.test(d.anio) || anio < hoy - 18 || anio > hoy - 2) e.anio = `Escribe un año válido, entre ${hoy - 18} y ${hoy - 2}.`;
  if (pideCategoria && !d.categoria) e.categoria = "Elige la categoría o «No estoy seguro/a».";
  return e;
}

function validarApoderado(d: { tutor: string; correo: string; telefono: string }): Errores {
  const e: Errores = {};
  if (!NOMBRE_RE.test(limpio(d.tutor))) e.tutor = "Escribe tu nombre completo (solo letras).";
  if (!normalizarCorreo(d.correo)) e.correo = "Revisa el correo: debe ser como nombre@dominio.cl.";
  if (!normalizarTelefono(d.telefono)) e.telefono = "Revisa el celular: 9 dígitos que empiezan con 9 (ej: 9 1234 5678).";
  return e;
}

function fechaCorta(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-CL", { day: "numeric", month: "long" });
}

function Fondo({ children }: { children: React.ReactNode }) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const presente = useMotionValue(0);
  const seguimiento = useMemo(() => ({ x, y, presente }), [x, y, presente]);
  return (
    <main className="menu-raiz">
      <div className="absolute inset-0" aria-hidden>
        <FondoVivo seguimiento={seguimiento} modo="inicio" />
        <div className="menu-velo" />
        <div className="menu-sombra" />
      </div>
      <div className="menu-logo">
        <Image src="/logo-blanco.png" alt="FA CUP Chile" width={469} height={100} priority className="h-full w-auto" />
      </div>
      <div className="ins-escena">{children}</div>
    </main>
  );
}

const sinSuscripcion = () => () => {};
const tokenActual = () => new URLSearchParams(window.location.search).get("t") ?? "";

export default function Inscripcion({ sede }: { sede: string }) {
  const token = useSyncExternalStore(sinSuscripcion, tokenActual, () => null); // null en el servidor
  const [intento, setIntento] = useState(0);
  const [res, setRes] = useState<{ clave: string; r: Carga } | null>(null);
  const clave = `${sede}|${token}|${intento}`;

  useEffect(() => {
    iniciarCalidad();
  }, []);

  useEffect(() => {
    if (!token) return;
    let vivo = true;
    infoInscripcion(token)
      .then((info) => vivo && setRes({ clave, r: { estado: "ok", info } }))
      .catch((e) => {
        if (!vivo) return;
        setRes({ clave, r: e instanceof ErrorInscripcion && e.codigo === "enlace_invalido" ? { estado: "invalido" } : { estado: "red", mensaje: e instanceof Error ? e.message : "No se pudo conectar." } });
      });
    return () => {
      vivo = false;
    };
  }, [token, clave]);

  const carga: Carga = token === "" ? { estado: "invalido" } : res && res.clave === clave ? res.r : { estado: "cargando" };

  if (carga.estado === "ok" && token) return <Formulario info={carga.info} token={token} />;
  return (
    <MotionConfig reducedMotion="user">
      <Fondo>
        <section className="ins-panel" aria-live="polite">
          <div className="ins-cuerpo">
            {carga.estado === "cargando" && (
              <p className="ins-p flex items-center gap-3" role="status">
                <Loader2 size={20} className="s-spin" aria-hidden /> Cargando…
              </p>
            )}
            {carga.estado === "invalido" && (
              <>
                <h1 className="ins-h" tabIndex={-1}>
                  Enlace no válido
                </h1>
                <p className="ins-p">Este enlace no es válido o venció. Pide uno nuevo al staff de la sede.</p>
              </>
            )}
            {carga.estado === "red" && (
              <>
                <h1 className="ins-h">Sin conexión</h1>
                <p className="ins-p">{carga.mensaje}</p>
              </>
            )}
          </div>
          {carga.estado === "red" && (
            <div className="ins-pie">
              <button type="button" className="ins-btn" onClick={() => setIntento((n) => n + 1)}>
                Reintentar
              </button>
            </div>
          )}
        </section>
      </Fondo>
    </MotionConfig>
  );
}

function Formulario({ info, token }: { info: InfoInscripcion; token: string }) {
  const [paso, setPaso] = useState<number>(P.bienvenida);
  // Hijo/a
  const [nombre, setNombre] = useState("");
  const [anio, setAnio] = useState("");
  const [categoria, setCategoria] = useState(""); // "" sin elegir, NO_SE, o el nombre
  // Apoderado (se conserva al inscribir otro hijo/a)
  const [tutor, setTutor] = useState("");
  const [parentesco, setParentesco] = useState<Parentesco>("");
  const [correo, setCorreo] = useState("");
  const [telefono, setTelefono] = useState("");
  // Autorizaciones (por cada niño: se vuelven a pedir, nunca premarcadas)
  const [acepta, setAcepta] = useState(false);
  const [aceptaCom, setAceptaCom] = useState(false);

  const [errores, setErrores] = useState<Errores>({});
  const [fotos, setFotos] = useState<(Foto | null)[]>([null, null, null]);
  const [malas, setMalas] = useState<number[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<ErrorInscripcion | null>(null);
  const [codigo, setCodigo] = useState("");
  const [enviados, setEnviados] = useState<string[]>([]); // nombres ya enviados en esta visita
  const cuerpo = useRef<HTMLDivElement>(null);
  const titulo = useRef<HTMLHeadingElement>(null);
  const envio = useRef(false);

  const nombreSede = /^sede\s/i.test(info.sede.nombre) ? info.sede.nombre : `Sede ${info.sede.nombre}`;
  const fijo = Boolean(info.categoria_fija);
  const pideCategoria = !fijo && info.categorias.length > 0;
  const otro = enviados.length > 0;
  const primerNombre = limpio(nombre).split(" ")[0] || "tu hijo/a";

  // Al cambiar de paso: arriba del todo y el foco al título (lectores de pantalla anuncian el paso).
  useEffect(() => {
    cuerpo.current?.scrollTo({ top: 0 });
    titulo.current?.focus({ preventScroll: true });
  }, [paso]);

  // Si el envío falla, la alerta puede quedar bajo el pliegue del panel: llevarla a la vista.
  useEffect(() => {
    if (!errorEnvio) return;
    const id = window.setTimeout(() => {
      cuerpo.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 50);
    return () => window.clearTimeout(id);
  }, [errorEnvio]);

  function enfocar(e: Errores, orden: Campo[]): boolean {
    const primero = orden.find((c) => e[c]);
    if (primero) document.getElementById(ID_CAMPO[primero])?.focus();
    return Boolean(primero);
  }

  function continuarHijo() {
    const e = validarHijo({ nombre, anio, categoria }, pideCategoria);
    setErrores(e);
    // Otro hijo/a: los datos del apoderado ya están; se pasa directo a las autorizaciones (con «Volver» se editan).
    if (!enfocar(e, ["nombre", "anio", "categoria"])) setPaso(otro ? P.autorizacion : P.apoderado);
  }

  function continuarApoderado() {
    const e = validarApoderado({ tutor, correo, telefono });
    setErrores(e);
    if (!enfocar(e, ["tutor", "correo", "telefono"])) setPaso(P.autorizacion);
  }

  async function enviar() {
    if (envio.current) return;
    const blobs = fotos.filter((f): f is Foto => f !== null).map((f) => f.blob);
    if (blobs.length < info.fotos.minimo) return;
    envio.current = true;
    setEnviando(true);
    setErrorEnvio(null);
    setMalas([]);
    try {
      const c = await enviarInscripcion({
        token,
        nombreNino: limpio(nombre),
        anioNacimiento: anio,
        categoria: fijo || categoria === NO_SE ? "" : categoria,
        tutorNombre: limpio(tutor),
        tutorCorreo: normalizarCorreo(correo) ?? correo.trim(),
        tutorTelefono: normalizarTelefono(telefono) ?? telefono.trim(),
        tutorParentesco: parentesco,
        aceptaComunicaciones: aceptaCom,
        fotos: blobs,
      });
      setCodigo(c);
      setEnviados((l) => [...l, limpio(nombre)]);
      setPaso(P.listo);
    } catch (e) {
      const err = e instanceof ErrorInscripcion ? e : new ErrorInscripcion("error", "No se pudo enviar. Intenta de nuevo.");
      setErrorEnvio(err);
      if (err.codigo === "enlace_invalido") {
        window.location.reload();
        return;
      }
      const campo = err.campo ? CAMPO_SERVIDOR[err.campo] : undefined;
      if (err.codigo === "datos_invalidos" && campo) {
        setErrores({ [campo]: err.message });
        setPaso(PASO_DE_CAMPO[campo]);
        window.setTimeout(() => document.getElementById(ID_CAMPO[campo])?.focus(), 350);
      } else if (err.codigo === "sin_consentimiento") {
        setAcepta(false);
        setPaso(P.autorizacion);
      } else if (err.foto) {
        // El servidor numera por orden de envío: coincide con las fotos tomadas, que están contiguas.
        const lista = fotos.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
        setMalas([lista[err.foto - 1] ?? -1].filter((i) => i >= 0));
      }
    } finally {
      envio.current = false;
      setEnviando(false);
    }
  }

  /** Otro hijo/a: se limpian los datos del niño, las fotos y las autorizaciones; el apoderado se conserva. */
  function otroHijo() {
    setNombre("");
    setAnio("");
    setCategoria("");
    setFotos([null, null, null]);
    setMalas([]);
    setAcepta(false);
    setAceptaCom(false);
    setErrores({});
    setErrorEnvio(null);
    setCodigo("");
    setPaso(P.hijo);
  }

  const nFotos = fotos.filter(Boolean).length;
  const etapa = ETAPA_DE_PASO[paso];
  const campoErr = (c: Campo) => (errores[c] ? { "aria-invalid": true as const, "aria-describedby": `${ID_CAMPO[c]}-err` } : {});
  const msgCampo = (c: Campo) =>
    errores[c] ? (
      <p id={`${ID_CAMPO[c]}-err`} className="ins-err" role="alert">
        {errores[c]}
      </p>
    ) : null;
  const alerta = errorEnvio && paso >= P.hijo && paso <= P.fotos ? errorEnvio.message : null;
  const alertaBloque = alerta ? (
    <p className="ins-alerta" role="alert">
      {alerta}
    </p>
  ) : null;

  return (
    <MotionConfig reducedMotion="user">
      <Fondo>
        <section className="ins-panel" aria-label="Inscripción">
          <ol className="ins-etapas" aria-label="Progreso de la inscripción">
            {ETAPAS.map((t, i) => (
              <li key={t} data-on={i <= etapa ? "" : undefined} aria-current={i === etapa ? "step" : undefined}>
                <i aria-hidden />
                <span>{t}</span>
              </li>
            ))}
          </ol>

          <div className="ins-cuerpo" ref={cuerpo}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={paso}
                initial={{ opacity: 0, x: 22 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -22, transition: { duration: 0.16 } }}
                transition={{ duration: 0.38, ease: EASE }}
              >
                {paso === P.bienvenida && (
                  <>
                    <h1 className="ins-h" ref={titulo} tabIndex={-1}>
                      Inscribe a tu hijo o hija
                    </h1>
                    <p className="ins-p">
                      {nombreSede}
                      {info.categoria_fija ? ` · ${info.categoria_fija}` : ""}
                    </p>
                    <ul className="ins-lista">
                      <li>
                        <Timer size={20} aria-hidden />
                        <span>Son unos 2 minutos: los datos del niño o niña, tus datos de contacto y 2 o 3 fotos de su cara.</span>
                      </li>
                      <li>
                        <ScanFace size={20} aria-hidden />
                        <span>Con las fotos, la cámara de la cancha lo reconoce al llegar y la asistencia queda registrada sola.</span>
                      </li>
                      <li>
                        <Lock size={20} aria-hidden />
                        <span>No guardamos las fotos: solo un código numérico por foto. Mientras el club revisa queda una miniatura, que se borra al aprobar o rechazar.</span>
                      </li>
                    </ul>
                    <p className="ins-ayuda mt-5">Este enlace vale hasta el {fechaCorta(info.expira)}.</p>
                  </>
                )}

                {paso === P.hijo && (
                  <>
                    <h1 className="ins-h" ref={titulo} tabIndex={-1}>
                      {otro ? "Otro hijo o hija" : "Tu hijo o hija"}
                    </h1>
                    {otro && (
                      <p className="ins-nota">
                        Usaremos los mismos datos de apoderado ({limpio(tutor)} · {normalizarCorreo(correo) ?? correo} · {telefonoLegible(normalizarTelefono(telefono) ?? telefono)}). No tienes que escribirlos de nuevo.
                      </p>
                    )}
                    <form
                      id="ins-hijo"
                      noValidate
                      onSubmit={(e) => {
                        e.preventDefault();
                        continuarHijo();
                      }}
                    >
                      <div className="ins-campo">
                        <label htmlFor="ins-nombre">Nombre y apellido</label>
                        <input id="ins-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} type="text" inputMode="text" autoComplete="off" autoCapitalize="words" enterKeyHint="next" maxLength={60} {...campoErr("nombre")} />
                        {msgCampo("nombre")}
                      </div>
                      <div className="ins-campo">
                        <label htmlFor="ins-anio">Año de nacimiento</label>
                        <input id="ins-anio" value={anio} onChange={(e) => setAnio(e.target.value.replace(/\D/g, "").slice(0, 4))} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" enterKeyHint={pideCategoria ? "next" : "done"} placeholder="Ej: 2016" {...campoErr("anio")} />
                        {msgCampo("anio")}
                      </div>
                      {pideCategoria && (
                        <div className="ins-campo">
                          <label htmlFor="ins-categoria">Categoría</label>
                          <select id="ins-categoria" value={categoria} onChange={(e) => setCategoria(e.target.value)} {...campoErr("categoria")} aria-describedby={errores.categoria ? "ins-categoria-err" : "ins-categoria-ayuda"}>
                            <option value="" disabled>
                              Elige una opción
                            </option>
                            {info.categorias.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            <option value={NO_SE}>No estoy seguro/a</option>
                          </select>
                          {errores.categoria ? (
                            msgCampo("categoria")
                          ) : (
                            <p id="ins-categoria-ayuda" className="ins-ayuda">
                              Si no la sabes, el staff la completa.
                            </p>
                          )}
                        </div>
                      )}
                      {fijo && <p className="ins-ayuda mt-4">Categoría: {info.categoria_fija}</p>}
                    </form>
                    {alertaBloque}
                  </>
                )}

                {paso === P.apoderado && (
                  <>
                    <h1 className="ins-h" ref={titulo} tabIndex={-1}>
                      Tus datos
                    </h1>
                    <p className="ins-p">Para que el club pueda avisarte sobre la inscripción y la asistencia de {primerNombre}.</p>
                    <form
                      id="ins-apoderado"
                      noValidate
                      onSubmit={(e) => {
                        e.preventDefault();
                        continuarApoderado();
                      }}
                    >
                      <div className="ins-campo">
                        <label htmlFor="ins-tutor">Tu nombre y apellido</label>
                        <input id="ins-tutor" value={tutor} onChange={(e) => setTutor(e.target.value)} type="text" inputMode="text" autoComplete="name" autoCapitalize="words" enterKeyHint="next" maxLength={60} {...campoErr("tutor")} />
                        {msgCampo("tutor")}
                      </div>
                      <fieldset className="ins-campo">
                        <legend>
                          Parentesco <span className="ins-opcional">(opcional)</span>
                        </legend>
                        <div className="ins-seg">
                          {PARENTESCOS.map((p) => (
                            <label key={p.valor}>
                              <input
                                id={`ins-parentesco-${p.valor}`}
                                type="radio"
                                name="parentesco"
                                value={p.valor}
                                checked={parentesco === p.valor}
                                onChange={() => setParentesco(p.valor)}
                                onClick={() => parentesco === p.valor && setParentesco("")}
                              />
                              {p.texto}
                            </label>
                          ))}
                        </div>
                        {msgCampo("parentesco")}
                      </fieldset>
                      <div className="ins-campo">
                        <label htmlFor="ins-correo">Correo</label>
                        <input id="ins-correo" value={correo} onChange={(e) => setCorreo(e.target.value)} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" maxLength={254} placeholder="nombre@correo.cl" {...campoErr("correo")} />
                        {msgCampo("correo")}
                      </div>
                      <div className="ins-campo">
                        <label htmlFor="ins-telefono">Celular</label>
                        <div className="ins-tel">
                          <span aria-hidden>+56</span>
                          <input
                            id="ins-telefono"
                            value={telefono}
                            onChange={(e) => setTelefono(e.target.value.replace(/[^\d\s+()-]/g, "").slice(0, 16))}
                            type="tel"
                            inputMode="tel"
                            autoComplete="tel-national"
                            enterKeyHint="done"
                            placeholder="9 1234 5678"
                            aria-label="Celular, 9 dígitos (código +56)"
                            {...campoErr("telefono")}
                          />
                        </div>
                        {msgCampo("telefono")}
                      </div>
                    </form>
                    {alertaBloque}
                  </>
                )}

                {paso === P.autorizacion && (
                  <>
                    <h1 className="ins-h" ref={titulo} tabIndex={-1}>
                      Autorizaciones
                    </h1>
                    <h2 className="ins-sub">Reconocimiento facial</h2>
                    <div className="ins-consent" tabIndex={0} role="region" aria-label="Texto de la autorización de reconocimiento facial">
                      {info.consentimiento.texto}
                    </div>
                    <label className="ins-check">
                      <input type="checkbox" checked={acepta} onChange={(e) => setAcepta(e.target.checked)} />
                      <span>Soy el padre, madre o tutor legal y autorizo el tratamiento de los datos biométricos de {primerNombre} descrito arriba.</span>
                    </label>

                    {info.comunicaciones && (
                      <>
                        <h2 className="ins-sub">
                          Comunicaciones <span className="ins-opcional">(opcional)</span>
                        </h2>
                        <div className="ins-consent" data-corto="" tabIndex={0} role="region" aria-label="Texto de la autorización de comunicaciones">
                          {info.comunicaciones.texto}
                        </div>
                        <label className="ins-check">
                          <input type="checkbox" checked={aceptaCom} onChange={(e) => setAceptaCom(e.target.checked)} />
                          <span>Acepto que el club me escriba al correo y al celular que indiqué. Si no la marcas, la inscripción sigue igual.</span>
                        </label>
                      </>
                    )}
                    {alertaBloque}
                  </>
                )}

                {paso === P.fotos && <FotosPaso titulo={titulo} fotos={fotos} setFotos={setFotos} malas={malas} setMalas={setMalas} maxMb={info.fotos.max_mb} alerta={alerta} />}

                {paso === P.listo && (
                  <>
                    <CheckCircle2 size={44} className="text-verde-pantalla" aria-hidden />
                    <h1 className="ins-h mt-4" ref={titulo} tabIndex={-1}>
                      Listo, recibimos la inscripción de {enviados[enviados.length - 1]?.split(" ")[0] ?? "tu hijo/a"}
                    </h1>
                    {codigo && (
                      <>
                        <p className="ins-p">Código de solicitud (por si el staff te lo pide):</p>
                        <p className="ins-codigo" aria-label={`Código ${codigo.split("").join(" ")}`}>
                          {codigo}
                        </p>
                      </>
                    )}
                    <h2 className="ins-sub">Qué pasa ahora</h2>
                    <ol className="ins-pasos">
                      <li>El staff de {nombreSede} revisa los datos y las fotos.</li>
                      <li>Cuando lo apruebe, ya puede marcar su llegada mirando la cámara en la cancha.</li>
                      <li>No necesitas hacer nada más. Si falta algo, el staff te contactará.</li>
                    </ol>
                    {enviados.length > 1 && <p className="ins-ayuda mt-4">Enviaste {enviados.length} inscripciones: {enviados.join(", ")}.</p>}
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="ins-pie">
            {paso > P.bienvenida && paso < P.listo && !(otro && paso === P.hijo) && (
              <button type="button" className="ins-btn" data-sec="" onClick={() => setPaso(paso - 1)} aria-label="Volver" disabled={enviando}>
                <ArrowLeft size={20} aria-hidden />
              </button>
            )}
            {paso === P.bienvenida && (
              <button type="button" className="ins-btn" onClick={() => setPaso(P.hijo)}>
                Comenzar
              </button>
            )}
            {paso === P.hijo && (
              <button type="submit" form="ins-hijo" className="ins-btn">
                Continuar
              </button>
            )}
            {paso === P.apoderado && (
              <button type="submit" form="ins-apoderado" className="ins-btn">
                Continuar
              </button>
            )}
            {paso === P.autorizacion && (
              <button type="button" className="ins-btn" disabled={!acepta} onClick={() => setPaso(P.fotos)}>
                Continuar a las fotos
              </button>
            )}
            {paso === P.fotos && (
              <button type="button" className="ins-btn" disabled={nFotos < info.fotos.minimo || enviando} aria-busy={enviando} onClick={enviar}>
                {enviando ? <Loader2 size={20} className="s-spin" aria-hidden /> : null}
                {enviando ? "Enviando…" : errorEnvio?.codigo === "red" ? "Reintentar envío" : "Enviar inscripción"}
              </button>
            )}
            {paso === P.listo && (
              <button type="button" className="ins-btn" data-sec="" style={{ flex: 1 }} onClick={otroHijo}>
                <UserPlus size={18} aria-hidden /> Inscribir a otro hijo/a
              </button>
            )}
          </div>
        </section>
      </Fondo>
    </MotionConfig>
  );
}
