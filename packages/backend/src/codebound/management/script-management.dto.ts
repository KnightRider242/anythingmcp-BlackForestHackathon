// SPDX-License-Identifier: AGPL-3.0-only
import { IsInt, IsOptional, IsString, Length, Max, Min, Validate, ValidatorConstraint } from 'class-validator';
import type { ValidatorConstraintInterface } from 'class-validator';
import type { ScriptDefinition } from '../contracts';
import { scriptDefinitionSchema } from '../contracts.validation';

@ValidatorConstraint({ name: 'scriptDefinition', async: false })
class DefinitionConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) { return scriptDefinitionSchema.safeParse(value).success; }
}
export class CreateScriptDto {
  @Validate(DefinitionConstraint)
  definition!: ScriptDefinition;
}
export class RevisionDto {
  @IsInt() @Min(1) @Max(2_147_483_647)
  expectedRevision!: number;
}
export class UpdateScriptDto extends CreateScriptDto {
  @IsInt() @Min(1) @Max(2_147_483_647)
  expectedRevision!: number;
}
export class ScriptPageDto {
  @IsOptional() @IsString() @Length(1, 128)
  afterId?: string;
}
