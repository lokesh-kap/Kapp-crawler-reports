import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
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
