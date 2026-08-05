

# Revv

**Revisión de código impulsada por IA en tu escritorio.**

Revv importa tus pull requests de GitHub y convierte la revisión en una experiencia rápida y conversacional. Obtén un recorrido generado por IA de cada cambio, chatea con un agente que entiende las diferencias (diff), deja comentarios que se sincronizan con GitHub e incluso propone y envía correcciones, todo sin salir de la aplicación.

Disponible para macOS.

---

## Por qué Revv

Revisar un PR grande suele significar desplazarse por una pared de diferencias en una pestaña del navegador, perder el hilo de lo importante y cambiar de contexto entre código, comentarios y conversaciones. Revv hace el trabajo pesado por ti:

- **Explica el cambio** antes de que leas una sola línea de diferencias.
- **Responde a tus preguntas** sobre el código en contexto.
- **Redacta correcciones** que puedes cherry-pick y enviar de vuelta.
- **Mantiene todo sincronizado** con GitHub, para que nada quede aislado.

## Características

- **PRs de GitHub sincronizados** — Tus pull requests se obtienen y mantienen actualizadas automáticamente en todos tus repositorios, en tiempo real.
- **Recorrido guiado por IA** — Cada PR recibe un recorrido estructurado generado por IA: un resumen en lenguaje sencillo, una evaluación de riesgos, un recorrido paso a paso por las diferencias, un veredicto general y una calificación de calidad en 9 ejes.
- **Agente de chat** — Un asistente siempre activo que entiende el PR. Pregúntale cualquier cosa sobre el cambio, que planifique una corrección y observa su trabajo transmitirse en vivo.
- **Proponer y enviar cambios** — Convierte las sugerencias del agente en commits reales. Cherry-pick lo que quieras, descarta el resto, resuelve conflictos de fusión con ayuda de IA y envía directamente a la rama.
- **Hilos de comentarios** — Hilos de revisión persistentes que se sincronizan bidireccionalmente con GitHub, además de sugerencias de código en línea que puedes aplicar con un clic.
- **Paleta de comandos** — `Cmd+P` para ir a cualquier PR, `Cmd+Shift+P` para comandos. Búsqueda difusa en todo.
- **Cuentas múltiples** — Inicia sesión con varias cuentas de GitHub; funciona tanto con `github.com` como con GitHub Enterprise.
- **Temas** — Claro, oscuro o del sistema, con un tema separado solo para las diferencias.

## Instalación

### macOS

```bash
curl -fsSL https://github.com/alexandre-schaffner/revv/releases/latest/download/install.sh | bash
```

Requiere macOS 10.15 (Catalina) o posterior. El instalador coloca `Revv.app`, configura el servidor local en segundo plano y añade una CLI `revv` para gestionar la instalación.

> Gatekeeper de macOS puede mostrar una advertencia de "desarrollador no identificado" hasta que se finalice la firma de código. Para abrirlo la primera vez: haz clic derecho en `Revv.app` → **Abrir**, luego **Abrir** nuevamente en el cuadro de diálogo.

<details>
<summary>Verifica el instalador antes de ejecutarlo</summary>

```bash
curl -fsSL https://github.com/alexandre-schaffner/revv/releases/latest/download/install.sh -o install.sh
gh attestation verify install.sh --repo alexandre-schaffner/revv
bash install.sh
```

</details>

## Inicio rápido

1. **Inicia Revv** y haz clic en **Iniciar sesión con GitHub**. Revv utiliza el flujo de código de dispositivo de GitHub: recibirás un código corto para ingresar en `github.com/login/device`. Apruébalo y entrarás.
2. **Selecciona tus repositorios.** Revv enumera los repositorios a los que tienes acceso; elige los que quieras revisar y comenzará a sincronizar sus PRs abiertas.
3. **Abre un pull request.** Presiona `Cmd+P`, busca el PR y ábrelo.
4. **Lee el recorrido.** Revv genera un recorrido con IA para el PR: comienza con el resumen y el nivel de riesgo, luego avanza por las diferencias.
5. **Chatea sobre el cambio.** Usa el panel derecho para hacerle preguntas al agente, solicitar una corrección o que te explique cualquier cosa que no entiendas.
6. **Comenta y envía de vuelta.** Deja comentarios de revisión (se sincronizan con GitHub), aplica sugerencias de código o acepta un commit propuesto por el agente y envíalo a la rama.

Eso es todo: tu revisión ocurre completamente dentro de Revv y todo lo que hagas fluye de vuelta a GitHub.

## Gestión de tu instalación

La CLI `revv` maneja el ciclo de vida:

```bash
revv status      # install paths, versions, server state, available updates
revv update      # update to the latest release
revv restart     # restart the background server
revv logs        # tail server logs
revv open        # launch the app
revv uninstall   # remove everything
```

## Solución de problemas

**"Error al iniciar la sesión: Falló la carga"** — La aplicación no puede conectarse a su servidor local. Verifica que esté en ejecución:

```bash
curl http://localhost:45678/    # any response (even 404) means it's up
revv restart                    # restart it if not
```

**"Error al iniciar la sesión"** — El servidor se conectó a GitHub pero recibió un error. La causa habitual es que el **Flujo de dispositivo no está habilitado** en tu aplicación OAuth de GitHub: habilítalo en `github.com/settings/developers` → tu aplicación → marca **Habilitar flujo de dispositivo** → Actualizar aplicación.

## Compilar desde el código fuente

Revv es un monorepo de Bun + TypeScript con un frontend SvelteKit, un servidor API Elysia y una carcasa de escritorio Tauri v2.

**Requisitos previos:** [Bun](https://bun.sh) 1.3+ y [Rust](https://rustup.rs), además de las herramientas de línea de comandos de Xcode para macOS (`xcode-select --install`).

```bash
git clone https://github.com/alexandre-schaffner/revv.git
cd revv
bun install
cp .env.example .env   # fill in GITHUB_CLIENT_ID and BETTER_AUTH_SECRET
make dev               # runs web, server, and desktop together
```

Consulta [`CLAUDE.md`](CLAUDE.md) para obtener la arquitectura completa, convenciones y flujo de trabajo para colaboradores.

## Contribuir

1. Crea una rama desde `main`
2. Realiza tu cambio y pruébalo con `make dev`
3. Ejecuta `make typecheck` y `make lint`
4. Abre un PR contra `main`

## Licencia

MIT
