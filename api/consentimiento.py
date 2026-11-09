"""Texto de consentimiento que acepta el padre, madre o tutor al inscribir a un niño con el enlace público.

BORRADOR — PENDIENTE DE REVISIÓN LEGAL (Ley 19.628 sobre protección de la vida privada y Ley 21.719 que la
reforma; datos biométricos de menores = datos sensibles). No usar en producción sin validación de un abogado.

Cada aceptación guarda la versión y el hash SHA-256 del texto exacto mostrado (tabla `consentimientos`), así que
cualquier cambio de redacción debe publicarse como una versión nueva (CONSENTIMIENTO_V2, ...), sin editar la V1.
"""

import hashlib

VERSION_V1 = "v1-borrador-2026-11"

CONSENTIMIENTO_V1 = """\
Autorización para el registro de asistencia con reconocimiento facial

Declaro que soy mayor de edad y que soy el padre, la madre o el tutor legal del niño o niña que inscribo, y que \
tengo facultad para autorizar el tratamiento de sus datos.

1. Para qué se usa. Los datos se usan solo para registrar la asistencia del niño o niña a los entrenamientos y \
partidos de la escuela de fútbol de esta sede. No se usan para publicidad, no se venden ni se comparten con \
terceros.

2. Qué se guarda. Con las fotos que envío se calcula un vector numérico (una lista de números) que permite \
reconocer el rostro. Las fotos originales NO se guardan. Mientras el club revisa la solicitud se guarda además \
una miniatura pequeña del rostro, que se elimina al aprobar o rechazar la solicitud. También se guardan el \
nombre y año de nacimiento del niño o niña, mi nombre y mi contacto.

3. Cuánto tiempo. Si la solicitud no se revisa, se elimina sola a los 30 días. Si se aprueba, los datos se \
conservan mientras el niño o niña participe en la escuela o hasta que yo retire esta autorización.

4. Mis derechos. Puedo pedir en cualquier momento acceder a los datos, corregirlos, eliminarlos o retirar esta \
autorización, sin expresión de causa. Al retirarla se borra el vector numérico y la asistencia se registra de \
forma manual. Para ejercer estos derechos puedo hablar con el encargado de la sede o escribir al contacto del \
club.

5. Voluntario. Esta autorización es voluntaria: si no la doy, el niño o niña puede participar igual y su \
asistencia se registrará de forma manual.

Al marcar la casilla de aceptación confirmo que leí y acepto esta autorización."""


def texto_hash(texto: str) -> str:
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


VIGENTE = {"version": VERSION_V1, "texto": CONSENTIMIENTO_V1, "texto_hash": texto_hash(CONSENTIMIENTO_V1)}


# Autorización de comunicaciones: SEPARADA del consentimiento biométrico, opcional y sin premarcar. Se guarda en la
# misma tabla de evidencia (`consentimientos.acepta_comunicaciones` + versión, hash y fecha). Quien no la acepta
# NUNCA debe recibir campañas ni recordatorios (el envío es una función futura: este flag es la única fuente).
# BORRADOR — PENDIENTE DE REVISIÓN LEGAL, igual que la V1 de arriba.
VERSION_COMUNICACIONES_V1 = "com-v1-borrador-2026-11"

COMUNICACIONES_V1 = """\
Autorización para recibir comunicaciones del club (opcional)

Autorizo al club a escribirme al correo y al teléfono (llamada, SMS o WhatsApp) que indiqué, solo para temas de \
la escuela de fútbol de mi hijo o hija: avisos de asistencia (por ejemplo, si falta varias veces seguidas), \
cambios de horario, partidos y novedades de la sede.

No se usarán para publicidad de terceros ni se compartirán. Es voluntaria: si no la doy, la inscripción sigue \
igual. Puedo retirarla cuando quiera hablando con el encargado de la sede o respondiendo a cualquiera de los \
mensajes."""

VIGENTE_COMUNICACIONES = {"version": VERSION_COMUNICACIONES_V1, "texto": COMUNICACIONES_V1,
                          "texto_hash": texto_hash(COMUNICACIONES_V1)}
