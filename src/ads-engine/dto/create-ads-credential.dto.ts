import { IsString, IsEnum, IsBoolean, IsOptional } from 'class-validator';
import { AdsProvider } from '../enums';

export class CreateAdsCredentialDto {
  @IsString()
  name: string;

  @IsEnum(AdsProvider)
  provider: AdsProvider;

  @IsString()
  refreshToken: string;

  @IsString()
  @IsOptional()
  clientId?: string;

  @IsString()
  @IsOptional()
  clientSecret?: string;

  @IsString()
  @IsOptional()
  developerToken?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
