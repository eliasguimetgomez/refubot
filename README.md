# RefuBot Góriz

Vigila una plaza de alojamiento interior en el Refugio de Góriz para la noche
del 17 al 18 de agosto de 2026, para una persona.

El bot abre el flujo oficial de reserva, selecciona **Refugio (dormitorio
compartido)**, marca exactamente esas fechas y una cama, y solo considera que
hay disponibilidad si la web acepta el rango y ofrece el botón para continuar.
No reserva, no inicia sesión, no introduce datos personales o de pago y no
intenta eludir bloqueos anti-bot.

## Configuración privada del correo

En `Settings` → `Secrets and variables` → `Actions`, crea estos dos secretos:

- `GMAIL_USER`: la cuenta de Gmail que enviará y recibirá la alerta.
- `GMAIL_APP_PASSWORD`: una contraseña de aplicación de Google; nunca uses la
  contraseña normal de Gmail ni la escribas en el código.

La vigilancia se ejecuta aproximadamente cada cinco minutos. GitHub puede
demorar una ejecución programada. Si la página falla o cambia, el bot no envía
una alerta. Tras el primer correo confirmado, guarda un marcador y desactiva el
workflow para evitar duplicados. También se detiene al finalizar la ventana de
vigilancia.

## Prueba manual

En `Actions` → `Vigilar plaza interior en Goriz` → `Run workflow`, deja
`dry_run` activado. La prueba consulta la web, pero no envía correo ni detiene
la vigilancia.

## Desarrollo

```bash
npm ci
npm test
DRY_RUN=true npm run check
```
