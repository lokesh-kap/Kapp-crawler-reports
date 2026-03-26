import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProviderFilterDto } from './create-provider-config.dto';
import { StepItemDto } from '../../client-wise/dto/step.dto';

export class UpsertProviderScraperConfigDto {
  @IsInt()
  config_id: number;

  @IsUrl()
  url: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProviderFilterDto)
  @IsOptional()
  filters?: ProviderFilterDto[];

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
