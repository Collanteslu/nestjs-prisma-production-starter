import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ZodResponse } from "nestjs-zod";
import type { Request } from "express";
import { NoEnvelope, TopLevelEnvelope } from "../common/decorators/envelope.decorator";
import { Public } from "../common/decorators/public.decorator";
import { ItemDto, SpikeBodyDto, SpikeParamDto, SpikeQueryDto } from "./spike.dto";

/**
 * Throwaway module used by the compatibility spike (Fase B) to verify, against the
 * real compiled app: body/params/query validation, defaulting/stripping, response
 * serialization + envelope ordering, envelope exceptions and status codes.
 * Removed once the real feature modules replace it.
 */
@ApiTags("spike")
@Controller("api/spike")
@Public() // dev routes stay reachable without a token (module removed at integration)
export class SpikeController {
  @Post("body")
  @ApiOperation({ summary: "Validated body (nested, defaults, enum, strip unknown)" })
  createBody(@Body() dto: SpikeBodyDto): SpikeBodyDto {
    return dto;
  }

  @Get("query")
  @ApiOperation({ summary: "Validated query (coercion, defaults, caps)" })
  query(@Query() dto: SpikeQueryDto): SpikeQueryDto {
    return dto;
  }

  @Get("echo-query")
  @NoEnvelope()
  @ApiOperation({ summary: "Raw query keys — verifies literal filter[...] parsing" })
  echoQuery(@Req() req: Request): Record<string, unknown> {
    return { keys: Object.keys(req.query), query: req.query };
  }

  @Get("param/:id")
  @ApiOperation({ summary: "Validated path param" })
  param(@Param() dto: SpikeParamDto): SpikeParamDto {
    return dto;
  }

  @Get("items")
  @ZodResponse({ status: 200, type: [ItemDto], description: "Serialized item list" })
  @ApiOperation({ summary: "Serializer + envelope ordering" })
  items(): ItemDto[] {
    const item = { id: "item-1", title: "Demo", secret: "must-be-stripped" };
    return [item];
  }

  @Post("toplevel")
  @HttpCode(200)
  @TopLevelEnvelope()
  @ApiOperation({ summary: "Top-level envelope (login/refresh style)" })
  toplevel(@Body() dto: SpikeBodyDto): Record<string, unknown> {
    return { message: "top-level ok", token: "fake-token", subject: dto.name };
  }

  @Get("raw")
  @NoEnvelope()
  @ApiOperation({ summary: "Envelope exception (health/index style)" })
  raw(): Record<string, unknown> {
    return { plain: true, success: "NOT-ADDED" };
  }

  @Get("conflict")
  @ApiOperation({ summary: "Domain error with grouped field errors" })
  conflict(): never {
    throw new HttpException(
      { message: "Resource already exists", errors: { code: ["already_taken"] } },
      409,
    );
  }

  @Get("created")
  @ApiOkResponse({ description: "Implicit status parity check" })
  created(): Record<string, unknown> {
    return { ok: true };
  }
}
