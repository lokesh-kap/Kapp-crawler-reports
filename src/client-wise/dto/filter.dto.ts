import { IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class FilterDto {
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

export class CredentialDto {
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
