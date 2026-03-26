import {
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
  @IsString()
  value_to_apply?: string;

  @IsOptional()
  @IsInt()
  delay?: number;

  @IsOptional()
  @IsString()
  xpath?: string;
}

export class ProviderCredentialDto {
  @IsOptional()
  @IsUrl()
  login_url?: string;

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
  @IsString()
  login_submit_xpath?: string;

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

  @ValidateNested()
  @Type(() => ProviderCredentialDto)
  @IsOptional()
  credentials?: ProviderCredentialDto;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
