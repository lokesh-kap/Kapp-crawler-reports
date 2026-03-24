import {
  ArrayNotEmpty,
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

export class ProviderFilterDto {
  @IsString()
  @IsNotEmpty()
  selector_type: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsInt()
  delay?: number;

  @IsOptional()
  @IsString()
  xpath?: string;
}

export class ProviderCredentialDto {
  @IsString()
  @IsNotEmpty()
  login: string;

  @IsString()
  @IsNotEmpty()
  password: string;

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

export class CreateProviderConfigDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsInt()
  config_id: number;

  @IsUrl()
  url: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ProviderFilterDto)
  filters: ProviderFilterDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProviderFilterDto)
  @IsOptional()
  advance_filters?: ProviderFilterDto[];

  @IsOptional()
  @IsBoolean()
  is_advance_filters?: boolean;

  @ValidateNested()
  @Type(() => ProviderCredentialDto)
  @IsOptional()
  credentials?: ProviderCredentialDto;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
