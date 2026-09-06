-- Cuando caduca la firma delegada de la cuenta (spec 028).
--
-- Las API wallets de Hyperliquid duran 90 dias por defecto y 180 como maximo.
-- Al vencer, el venue deja de aceptar la firma: los bots no pueden colocar ni
-- cancelar, y las posiciones abiertas se quedan sin nadie que las vigile. No se
-- pierde dinero —un agente no puede retirar ni transferir— pero el usuario se
-- entera cuando el bot ya no hace nada, porque la app no tenia esta fecha.
--
-- La rellena `verify()` desde `extraAgents` al crear la conexion y cada vez que
-- se reverifica. NULL = no se sabe, o la credencial de ese venue no caduca
-- (Aster y Lighter): la app entonces no pinta nada.
--
-- Una columna NULL, sin defecto y sin indice: no reescribe la tabla ni toca
-- ninguna fila. Las cuentas ya guardadas se quedan a NULL hasta que alguien
-- pulse «Reverificar».

ALTER TABLE "exchange_accounts"
  ADD COLUMN "agent_valid_until" TIMESTAMPTZ(6);
