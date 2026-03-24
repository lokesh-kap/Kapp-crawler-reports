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
import { CredentialDto, FilterDto } from './filter.dto';

export class CreateClientWiseFromProviderDto {
  @IsInt()
  provider_config_id: number;

  @IsOptional()
  @IsInt()
  config_id?: number;

  @IsInt()
  client_id: number;

  @IsInt()
  year: number;

  @IsInt()
  user_id: number;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUrl()
  url?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterDto)
  filters?: FilterDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterDto)
  advance_filters?: FilterDto[];

  @IsOptional()
  @IsBoolean()
  is_advance_filters?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => CredentialDto)
  credentials?: CredentialDto;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
