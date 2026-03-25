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

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterDto)
  @IsOptional()
  advance_filters?: FilterDto[];

  @IsOptional()
  @IsBoolean()
  is_advance_filters?: boolean;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
