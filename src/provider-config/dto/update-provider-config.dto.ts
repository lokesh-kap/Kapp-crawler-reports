import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class ProviderFilterDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  selector_type?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsInt()
  delay?: number;

  @IsOptional()
  @IsString()
  xpath?: string;
}

class ProviderCredentialDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  login?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  password?: string;

  @IsOptional()
  @IsString()
  login_selector_type?: string;

  @IsOptional()
  @IsString()
  login_xpath?: string;

  @IsOptional()
  @IsString()
  password_selector_type?: string;

  @IsOptional()
  @IsString()
  password_xpath?: string;

  @IsOptional()
  @IsInt()
  delay?: number;
}

export class UpdateProviderConfigDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsInt()
  config_id?: number;

  @IsOptional()
  @IsUrl()
  url?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProviderFilterDto)
  filters?: ProviderFilterDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProviderFilterDto)
  advance_filters?: ProviderFilterDto[];

  @IsOptional()
  @IsBoolean()
  is_advance_filters?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProviderCredentialDto)
  credentials?: ProviderCredentialDto;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
