import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class ProviderCredentialDto {
  @IsOptional()
  login_url?: string;

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
  @IsString()
  login_submit_xpath?: string;

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
  @ValidateNested()
  @Type(() => ProviderCredentialDto)
  credentials?: ProviderCredentialDto;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
