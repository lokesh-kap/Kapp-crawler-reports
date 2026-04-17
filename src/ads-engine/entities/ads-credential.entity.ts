import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { AdsProvider } from '../enums';

@Entity('ads_credentials')
export class AdsCredential {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ type: 'enum', enum: AdsProvider })
  provider: AdsProvider;

  @Column({ type: 'text' })
  refreshToken: string;

  @Column({ type: 'text', nullable: true })
  accessToken: string;

  @Column({ type: 'text', nullable: true })
  clientId: string;

  @Column({ type: 'text', nullable: true })
  clientSecret: string;

  @Column({ type: 'text', nullable: true })
  developerToken: string;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
