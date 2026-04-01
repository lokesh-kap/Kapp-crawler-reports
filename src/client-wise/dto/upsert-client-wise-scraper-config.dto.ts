import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { FilterDto } from './filter.dto';
import { StepItemDto } from './step.dto';

export class UpsertClientWiseScraperConfigDto {
  @IsInt()
  client_id: number;

  @IsInt()
  year: number;

  @IsInt()
  user_id: number;

  @IsInt()
  config_id: number;

  @IsUrl()
  url: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterDto)
  @IsOptional()
  filters?: FilterDto[];

  @IsOptional()
  @IsBoolean()
  is_advance_filters?: boolean;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return value;
  })
  @IsBoolean()
  has_extra_steps?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StepItemDto)
  normal_steps?: StepItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StepItemDto)
  advanced_steps?: StepItemDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StepItemDto)
  extra_steps?: StepItemDto[];

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
