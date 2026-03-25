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

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProviderFilterDto)
  @IsOptional()
  advance_filters?: ProviderFilterDto[];

  @IsOptional()
  @IsBoolean()
  is_advance_filters?: boolean;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
