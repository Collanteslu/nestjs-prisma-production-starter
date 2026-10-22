import { Global, Module } from "@nestjs/common";
import { MfaService } from "./mfa.service";
import { TotpService } from "./totp.service";

/**
 * TOTP + recovery-code verification services. Global and always imported: the login
 * handler checks the second factor in every auth mode (a user enrolled under
 * AUTH_MODE=full must still be challenged after a restart in basic mode), while the
 * MFA *routes* live in MfaRoutesModule and only exist with AUTH_MODE=full.
 */
@Global()
@Module({
  providers: [TotpService, MfaService],
  exports: [TotpService, MfaService],
})
export class MfaModule {}
