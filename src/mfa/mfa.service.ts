import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { TotpService } from "./totp.service";

interface SecondFactorSubject {
  id: string;
  totpSecret: string | null;
  totpLastStep: number | null;
}

/**
 * Second-factor checks shared by login and the MFA management endpoints
 * (port of services/mfa.ts). Every claim is a single conditional statement,
 * so concurrent requests can never spend the same code or step twice.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly totp: TotpService,
  ) {}

  /**
   * Verifies a TOTP code for a user. A step is accepted at most once: the `totpLastStep` update is
   * a conditional single statement, so two concurrent requests cannot both use the same code.
   */
  async verifyUserTotp(user: SecondFactorSubject, code: string): Promise<boolean> {
    if (!user.totpSecret) return false;
    const step = this.totp.verifyTotp(
      this.totp.decryptSecret(user.totpSecret),
      code,
      user.totpLastStep,
    );
    if (step === null) return false;
    const claimed = await this.prisma.user.updateMany({
      where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return claimed.count === 1;
  }

  /** Consumes a one-time recovery code (atomic: it works once) */
  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const claimed = await this.prisma.recoveryCode.updateMany({
      where: { userId, codeHash: this.totp.hashRecoveryCode(code), usedAt: null },
      data: { usedAt: new Date() },
    });
    return claimed.count === 1;
  }

  /** Checks whichever second factor the caller provided */
  async verifySecondFactor(
    user: SecondFactorSubject,
    factor: { code?: string; recoveryCode?: string },
  ): Promise<boolean> {
    if (factor.code) return this.verifyUserTotp(user, factor.code);
    if (factor.recoveryCode) return this.consumeRecoveryCode(user.id, factor.recoveryCode);
    return false;
  }
}
