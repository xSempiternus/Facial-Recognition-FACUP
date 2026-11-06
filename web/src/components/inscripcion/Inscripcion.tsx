"use client";

// Formulario público para padres (/s/<sede>/inscripcion?t=<token>): bienvenida -> datos -> consentimiento -> fotos -> listo.
// Misma estética que el menú: foto de fondo, cristal oscuro, verde de marca. Pensado para el teléfono en la mano.

import { AnimatePresence, MotionConfig, motion, useMotionValue } from "motion/react";
import { ArrowLeft, CheckCircle2, Loader2, Lock, ScanFace, ShieldCheck } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import FondoVivo from "@/components/kiosko/FondoVivo";
import { iniciarCalidad } from "@/components/kiosko/calidad";
import { enviarInscripcion, ErrorInscripcion, infoInscripcion, type InfoInscripcion } from "@/lib/inscripcion-api";
import { iniciarSonidos, sonar } from "@/lib/sonidos";
import { FotosPaso, type Foto } from "./Fotos";

const EASE = [0.22, 1, 0.36, 1] as const;
const NOMBRE_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]{1,59}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/;
const TEL_RE = /^\+?[0-9]{8,15}$/;

type Campo = "nombre" | "anio" | "categoria" | "tutor" | "contacto";
type Errores = Partial<Record<Campo, string>>;
type Carga = { estado: "cargando" } | { estado: "invalido" } | { estado: "red"; mensaje: string } | { estado: "ok"; info: InfoInscripcion };

const CAMPO_SERVIDOR: Record<string, Campo> = {
  nombre_nino: "nombre",
  anio_nacimiento: "anio",
  categoria: "categoria",
  tutor_nombre: "tutor",
  tutor_contacto: "contacto",
};
const ID_CAMPO: Record<Campo, string> = { nombre: "ins-nombre", anio: "ins-anio", categoria: "ins-categoria", tutor: "ins-tutor", contacto: "ins-contacto" };

function validar(d: { nombre: string; anio: string; tutor: string; contacto: string }): Errores {
  const e: Errores = {};
  const nombre = d.nombre.split(/\s+/).filter(Boolean).join(" ");
  if (!NOMBRE_RE.test(nombre) || !nombre.includes(" ")) e.nombre = "Escribe el nombre y apellido del niño o niña (solo letras).";
  const anio = Number(d.anio);
  const hoy = new Date().getFullYear();
  if (!/^\d{4}$/.test(d.anio) || anio < hoy - 18 || anio > hoy - 2) e.anio = `Escribe un año válido, entre ${hoy - 18} y ${hoy - 2}.`;
  if (!NOMBRE_RE.test(d.tutor.split(/\s+/).filter(Boolean).join(" "))) e.tutor = "Escribe tu nombre completo (solo letras).";
  const c = d.contacto.trim();
  const okContacto = c.includes("@") ? c.length <= 254 && EMAIL_RE.test(c) : TEL_RE.test(c.replace(/[\s().-]/g, ""));
  if (!okContacto) e.contacto = "Escribe un correo o un teléfono válido.";
  return e;
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
                <p className="ins-p">Este enlace no es válido o venció. Pide uno nuevo al staff.</p>
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
  const [paso, setPaso] = useState(0); // 0 bienvenida, 1 datos, 2 consentimiento, 3 fotos, 4 listo
  const [nombre, setNombre] = useState("");
  const [anio, setAnio] = useState("");
  const [categoria, setCategoria] = useState(info.categoria_fija ?? "");
  const [tutor, setTutor] = useState("");
  const [contacto, setContacto] = useState("");
  const [acepta, setAcepta] = useState(false);
  const [errores, setErrores] = useState<Errores>({});
  const [fotos, setFotos] = useState<(Foto | null)[]>([null, null, null]);
  const [malas, setMalas] = useState<number[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<ErrorInscripcion | null>(null);
  const [codigo, setCodigo] = useState("");
  const cuerpo = useRef<HTMLDivElement>(null);
  const titulo = useRef<HTMLHeadingElement>(null);
  const envio = useRef(false);

  const nombreSede = /^sede\s/i.test(info.sede.nombre) ? info.sede.nombre : `Sede ${info.sede.nombre}`;
  const fijo = Boolean(info.categoria_fija);

  // Al cambiar de paso: arriba del todo y el foco al título (lectores de pantalla anuncian el paso).
  useEffect(() => {
    cuerpo.current?.scrollTo({ top: 0 });
    titulo.current?.focus({ preventScroll: true });
  }, [paso]);

  function ir(n: number) {
    sonar(n > paso ? "tap" : "volver");
    setPaso(n);
  }

  function empezar() {
    iniciarSonidos();
    ir(1);
  }

  function continuarDatos() {
    const e = validar({ nombre, anio, tutor, contacto });
    setErrores(e);
    const primero = (Object.keys(ID_CAMPO) as Campo[]).find((c) => e[c]);
    if (primero) {
      sonar("aviso");
      document.getElementById(ID_CAMPO[primero])?.focus();
      return;
    }
    ir(2);
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
        nombreNino: nombre.split(/\s+/).filter(Boolean).join(" "),
        anioNacimiento: anio,
        categoria: fijo ? "" : categoria,
        tutorNombre: tutor.split(/\s+/).filter(Boolean).join(" "),
        tutorContacto: contacto.trim(),
        fotos: blobs,
      });
      sonar("exito");
      setCodigo(c);
      setPaso(4);
    } catch (e) {
      sonar("error");
      const err = e instanceof ErrorInscripcion ? e : new ErrorInscripcion("error", "No se pudo enviar. Intenta de nuevo.");
      setErrorEnvio(err);
      if (err.codigo === "enlace_invalido") {
        window.location.reload();
        return;
      }
      const campo = err.campo ? CAMPO_SERVIDOR[err.campo] : undefined;
      if (err.codigo === "datos_invalidos" && campo) {
        setErrores({ [campo]: err.message });
        setPaso(1);
        window.setTimeout(() => document.getElementById(ID_CAMPO[campo])?.focus(), 350);
      } else if (err.codigo === "sin_consentimiento") {
        setAcepta(false);
        setPaso(2);
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

  const nFotos = fotos.filter(Boolean).length;
  const campoErr = (c: Campo) => (errores[c] ? { "aria-invalid": true as const, "aria-describedby": `${ID_CAMPO[c]}-err` } : {});
  const msgCampo = (c: Campo) =>
    errores[c] ? (
      <p id={`${ID_CAMPO[c]}-err`} className="ins-err" role="alert">
        {errores[c]}
      </p>
    ) : null;
  const alerta = errorEnvio && (paso === 3 || paso === 1 || paso === 2) ? errorEnvio.message : null;

  return (
    <MotionConfig reducedMotion="user">
      <Fondo>
        <section className="ins-panel" aria-label="Inscripción">
          {paso < 4 && (
            <div className="ins-progreso" role="progressbar" aria-label="Progreso" aria-valuemin={1} aria-valuemax={4} aria-valuenow={paso + 1} aria-valuetext={`Paso ${paso + 1} de 4`}>
              {[0, 1, 2, 3].map((i) => (
                <i key={i} data-on={i <= paso ? "" : undefined} />
              ))}
            </div>
          )}

          <div className="ins-cuerpo" ref={cuerpo}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={paso}
                initial={{ opacity: 0, x: 22 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -22, transition: { duration: 0.16 } }}
                transition={{ duration: 0.38, ease: EASE }}
              >
                {paso === 0 && (
                  <>
                    <h1 className="ins-h" ref={titulo} tabIndex={-1}>
                      Inscribe a tu hijo o hija
                    </h1>
                    <p className="ins-p">{nombreSede}</p>
                    <ul className="ins-lista">
                      <li>
                        <ScanFace size={20} aria-hidden />
                        <span>Registramos la asistencia en la cancha con reconocimiento facial: el niño o niña mira la cámara y listo.</span>
                      </li>
                      <li>
                        <Lock size={20} aria-hidden />
                        <span>No se guarda la foto: solo un código numérico (vector) por foto. Mientras el club revisa se guarda una miniatura, que se borra al aprobar o rechazar.</span>
                      </li>
                      <li>
                        <ShieldCheck size={20} aria-hidden />
                        <span>Te tomará unos 3 minutos: datos, autorización y 2 o 3 fotos del rostro.</span>
                      </li>
                    </ul>
                  </>
                )}

                {paso === 1 && (
                  <>
                    <h1 className="ins-h" ref={titulo} tabIndex={-1}>
                      Datos
                    </h1>
                    <form
                      id="ins-datos"
                      noValidate
                      onSubmit={(e) => {
                        e.preventDefault();
                        continuarDatos();
                      }}
                    >
                      <div className="ins-campo">
                        <label htmlFor="ins-nombre">Nombre completo del niño o niña</label>
                        <input id="ins-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} type="text" inputMode="text" autoComplete="off" autoCapitalize="words" enterKeyHint="next" maxLength={60} {...campoErr("nombre")} />
                        {msgCampo("nombre")}
                      </div>
                      <div className="ins-campo">
                        <label htmlFor="ins-anio">Año de nacimiento</label>
                        <input id="ins-anio" value={anio} onChange={(e) => setAnio(e.target.value.replace(/\D/g, "").slice(0, 4))} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" enterKeyHint="next" placeholder="Ej: 2016" {...campoErr("anio")} />
                        {msgCampo("anio")}
                      </div>
                      {!fijo && info.categorias.length > 0 && (
                        <div className="ins-campo">
                          <label htmlFor="ins-categoria">Categoría (opcional)</label>
                          <select id="ins-categoria" value={categoria} onChange={(e) => setCategoria(e.target.value)} {...campoErr("categoria")}>
                            <option value="">No estoy segura o seguro</option>
                            {info.categorias.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          {msgCampo("categoria")}
                        </div>
                      )}
                      {fijo && <p className="ins-p">Categoría: {info.categoria_fija}</p>}
                      <div className="ins-campo">
                        <label htmlFor="ins-tutor">Tu nombre (padre, madre o tutor)</label>
                        <input id="ins-tutor" value={tutor} onChange={(e) => setTutor(e.target.value)} type="text" inputMode="text" autoComplete="name" autoCapitalize="words" enterKeyHint="next" maxLength={60} {...campoErr("tutor")} />
                        {msgCampo("tutor")}
                      </div>
                      <div className="ins-campo">
                        <label htmlFor="ins-contacto">Correo o teléfono de contacto</label>
                        <input id="ins-contacto" value={contacto} onChange={(e) => setContacto(e.target.value)} type="text" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="done" maxLength={254} {...campoErr("contacto")} />
                        {msgCampo("contacto")}
                      </div>
                    </form>
                    {alerta && (
                      <p className="ins-alerta" role="alert">
                        {alerta}
                      </p>
                    )}
                  </>
                )}

                {paso === 2 && (
                  <>
                    <h1 className="ins-h" ref={titulo} tabIndex={-1}>
                      Autorización
                    </h1>
                    <p className="ins-p">Lee con calma antes de continuar.</p>
                    <div className="ins-consent" tabIndex={0} role="region" aria-label="Texto de la autorización">
                      {info.consentimiento.texto}
                    </div>
                    <label className="ins-check">
                      <input type="checkbox" checked={acepta} onChange={(e) => setAcepta(e.target.checked)} />
                      <span>Soy el padre, madre o tutor legal y autorizo el tratamiento de los datos biométricos de mi hijo o hija descrito arriba.</span>
                    </label>
                    {alerta && (
                      <p className="ins-alerta" role="alert">
                        {alerta}
                      </p>
                    )}
                  </>
                )}

                {paso === 3 && <FotosPaso titulo={titulo} fotos={fotos} setFotos={setFotos} malas={malas} setMalas={setMalas} maxMb={info.fotos.max_mb} alerta={alerta} />}

                {paso === 4 && (
                  <>
                    <CheckCircle2 size={44} className="text-verde-pantalla" aria-hidden />
                    <h1 className="ins-h mt-4" ref={titulo} tabIndex={-1}>
                      Listo, quedó pendiente de confirmación del staff
                    </h1>
                    {codigo && (
                      <>
                        <p className="ins-p">Tu código de solicitud:</p>
                        <p className="ins-codigo" aria-label={`Código ${codigo.split("").join(" ")}`}>
                          {codigo}
                        </p>
                      </>
                    )}
                    <p className="ins-p">No necesitas hacer nada más. Si el staff necesita algo, te contactará.</p>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {paso < 4 && (
            <div className="ins-pie">
              {paso > 0 && (
                <button type="button" className="ins-btn" data-sec="" onClick={() => ir(paso - 1)} aria-label="Volver" disabled={enviando}>
                  <ArrowLeft size={20} aria-hidden />
                </button>
              )}
              {paso === 0 && (
                <button type="button" className="ins-btn" onClick={empezar}>
                  Comenzar
                </button>
              )}
              {paso === 1 && (
                <button type="submit" form="ins-datos" className="ins-btn">
                  Continuar
                </button>
              )}
              {paso === 2 && (
                <button type="button" className="ins-btn" disabled={!acepta} onClick={() => ir(3)}>
                  Acepto y continúo
                </button>
              )}
              {paso === 3 && (
                <button type="button" className="ins-btn" disabled={nFotos < info.fotos.minimo || enviando} aria-busy={enviando} onClick={enviar}>
                  {enviando ? <Loader2 size={20} className="s-spin" aria-hidden /> : null}
                  {enviando ? "Enviando…" : errorEnvio?.codigo === "red" ? "Reintentar envío" : "Enviar solicitud"}
                </button>
              )}
            </div>
          )}
        </section>
      </Fondo>
    </MotionConfig>
  );
}
