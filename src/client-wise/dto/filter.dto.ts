import { IsInt, IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

export class FilterDto {
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

export class CredentialDto {
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
