import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class StepItemDto {
  @IsString()
  @IsIn([
    'click',
    'fill_text',
    'select',
    'searchable_dropdown',
    'checkbox',
    'radio',
    'submit',
    'wait_visible',
    'wait_hidden',
  ])
  step_type: string;

  @IsString()
  xpath: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sequence?: number;

  @IsOptional()
  @IsObject()
  meta_data?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class StepGroupPayloadDto {
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StepItemDto)
  normal_steps?: StepItemDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StepItemDto)
  advanced_steps?: StepItemDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StepItemDto)
  extra_steps?: StepItemDto[];
}

